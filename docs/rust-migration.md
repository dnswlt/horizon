# Migration plan: Python/FastAPI → Rust (axum + wry)

> **Status: completed 2026-07-11.** All six phases landed; the Python
> backend is gone. Kept for the rationale behind the API/data-format
> decisions. Deviations from the plan as written: rust-embed's debug mode
> already serves `static/` from disk, so no `--static-dir` flag was needed;
> the release asset is the bare `Horizon-<version>.exe` rather than a zip;
> and the content `PATCH` requires all three fields (see below).

## Motivation

The current Windows distribution is a ~60 MB zip containing a full Python
runtime (PyInstaller onedir). Users must unzip it, unblock it, and keep a
folder around. A Rust backend compiles to a single small `.exe` with SQLite
and all static assets embedded, while keeping the two usage modes we care
about:

1. **Pinned taskbar app** (primary): native WebView2 window via `wry`.
2. **Classic backend + browser** (hard requirement): the same binary run as a
   plain HTTP server, opened in any browser.

We deliberately do **not** use Tauri: it would replace the HTTP client/server
model with its IPC bridge. `wry` is just the window + webview layer; the app
remains an ordinary web app talking to `127.0.0.1`.

## Goals and non-goals

- **Goal:** feature parity — every current behavior survives.
- **Non-goal:** wire-format parity. Where the Python implementation leaked
  awkward representations into the API or DB (integer booleans, mixed
  timestamp formats, absent-vs-null field semantics), we fix them now and
  update the frontend to match. This is the moment to break things.
- **Goal:** existing user databases keep working via a one-time, versioned
  DB migration on first launch of the Rust build.

## Target architecture

One binary, `horizon.exe`:

- **Default (no args):** start the axum server on a background thread bound to
  `127.0.0.1:8063`, wait until the port accepts connections, then open a
  1200×800 `wry`/`tao` window titled "Horizon". Closing the window exits the
  process (replaces `run.py`).
- **`--serve [--port N]`:** headless server only; use a browser. Replaces
  `uvicorn server:app` for both development and browser-mode users.

Console handling: `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
— dev builds keep a console, release builds don't. Both modes log to
`horizon.log` next to the exe (as today), so the windowed build stays
debuggable when a user reports "it won't open".

Static assets are embedded with `rust-embed`. A `--static-dir <path>` flag (or
debug-build default) serves from disk instead, so frontend edits don't require
a rebuild during development.

### Crates

| Concern | Crate | Notes |
|---|---|---|
| HTTP server | `axum` + `tokio` | |
| SQLite | `rusqlite` (`bundled` feature) | SQLite compiled in, no DLL; `Mutex<Connection>` is plenty for a single-user app — no pool, no async DB layer |
| JSON | `serde`, `serde_json` | |
| Embedded assets | `rust-embed` | |
| IDs | `uuid` (v4) | |
| Time | `time` | RFC 3339 formatting/parsing |
| Window | `wry` + `tao` | WebView2 on Windows |
| Dark titlebar | `windows` | `DwmSetWindowAttribute` |
| Logging | `log` + `simplelog` (file target) | |
| Icon/version resource | `embed-resource` or `winres` in `build.rs` | |

## Data model modernization

SQLite schema stays structurally the same (tables `tasks`, `task_updates`,
`settings`), with these format changes:

1. **Timestamps: RFC 3339 UTC everywhere** (`2026-07-11T12:34:56Z`) for
   `created_at`, `completed_at`, `deleted_at`, `waiting_since`, and
   `task_updates.created_at`. Today the DB mixes SQL `CURRENT_TIMESTAMP`
   (`YYYY-MM-DD HH:MM:SS`) with Python-written `YYYY-MM-DDTHH:MM:SSZ`.
   Timestamps are generated in Rust (`time::OffsetDateTime::now_utc()`), not
   via SQL `CURRENT_TIMESTAMP`, so there is exactly one format.
2. **Calendar dates stay plain `YYYY-MM-DD`** (`due_date`, `defer_until`) —
   they are local-day concepts, not instants. The "is this snooze still
   active" comparison uses today's *local* date, computed in Rust and passed
   as a query parameter instead of SQL `date('now', 'localtime')`.
3. **Booleans:** `completed` remains an `INTEGER` column (SQLite has no bool;
   `rusqlite` maps `bool` ↔ 0/1 natively), but it is a real `bool` in Rust
   structs and `true`/`false` in JSON.

### Versioned migrations

Replace the ad-hoc `PRAGMA table_info` column probing with a proper migration
runner keyed on `PRAGMA user_version`:

- **v0 → v1:** everything the Python `_migrate_schema` does (add
  `completed_at`, `deleted_at`, `defer_until`, `waiting_since` if missing;
  backfill `completed_at`), **plus** the format upgrade: rewrite all
  `YYYY-MM-DD HH:MM:SS` timestamps to RFC 3339 (they are already UTC, so this
  is a pure reformat). Also the `task_updates` "Task created" backfill.
- Fresh DBs are created directly at the current version and seeded with the
  demo tasks (port of `_seed_demo_tasks`), only when `tasks` is empty.

The migration runs inside a transaction on startup. Existing Python-era
`tasks.db` files upgrade transparently on first launch; the old zip install
keeps working until the user switches, since the DB lives next to whichever
exe is running.

## API modernization

The frontend is updated in lockstep (it's ~10 call sites; `apiFetch` /
`patchTask` centralize the contract). Changes:

1. **`completed` is a JSON boolean** in responses. The frontend already
   treats it truthily and already *sends* booleans, so read-side changes are
   nil.
2. **Split the omnibus `PUT /api/tasks/{id}`** — which currently multiplexes
   six unrelated state changes and needs "was this field present?"
   introspection (Pydantic `model_fields_set`) — into intent-shaped
   endpoints. Every payload field becomes *required but nullable*, which in
   Rust is a plain `Option<T>` with no `#[serde(default)]`: a missing key is
   a 422, `null` is an explicit value. No double-`Option`, no custom
   deserializers.

   | Endpoint | Body | Replaces |
   |---|---|---|
   | `PATCH /api/tasks/{id}` | `{title, description, due_date}` — content edits only; all fields required, `due_date: null` clears | `PUT` with `title`/`description`/`due_date` |
   | `POST /api/tasks/{id}/complete` | `{completed: bool}` | `PUT {completed}` |
   | `POST /api/tasks/{id}/snooze` | `{until: "YYYY-MM-DD" \| null}` — `null` un-snoozes/dismisses resurfaced badge | `PUT {defer_until}` |
   | `POST /api/tasks/{id}/wait` | `{waiting: bool}` — `true` also clears `due_date`/`defer_until` | `PUT {waiting}` |
   | `POST /api/tasks/{id}/restore` | — (restores from trash) | `PUT {deleted: false}` |
   | `DELETE /api/tasks/{id}` | — (soft delete, unchanged) | unchanged |

   The one place a "present vs. absent" question remains is the content
   `PATCH` (`due_date` set-vs-clear while `title` may be omitted). The
   current frontend always sends all three fields together from the edit
   dialog, so we make that the contract: **all three fields required**,
   nullable `due_date`. Plain `Option<String>` again.

   Business rules that move with the endpoints: scheduling a task onto a real
   day (non-null `due_date` via `PATCH` or reorder) clears `defer_until`;
   entering the waiting list stamps `waiting_since` and clears
   `due_date`/`defer_until`; completing stamps `completed_at`, reopening
   clears it.
3. **Read endpoints unchanged in shape** (list of task objects / `{tasks,
   has_more}` envelopes), modulo the boolean and timestamp format changes:
   `/api/tasks`, `/open`, `/waiting`, `/snoozed`, `/archive`, `/deleted`,
   `/search`, `/{id}/updates`, plus the `settings/contexts` GET/PUT and the
   task-updates CRUD (`POST /{id}/updates`, `PUT`/`DELETE /api/updates/{id}`)
   and `POST /api/tasks/reorder`.
4. **Search semantics ported as-is:** whitespace-split words ANDed across
   title / description / user updates, LIKE with `\` escaping of `%`/`_`,
   `after`/`before` bounding `completed_at`, `include_done`, `limit`.
   Date-boundary comparisons against `completed_at` still work after the
   timestamp reformat because `YYYY-MM-DD` < `YYYY-MM-DDT...` sorts correctly.
5. **Errors:** `{"error": "message"}` with appropriate status codes (the
   frontend only checks `res.ok`, so this is cosmetic; FastAPI's `detail`
   shape is not worth preserving).

### Frontend touch-ups (same commit as the API change)

- `patchTask` callers move to the new endpoints (~8 call sites: complete ×3,
  snooze/un-snooze/dismiss, wait/un-wait, restore, edit dialog).
- `formatTimestamp` / `formatWaitingSince` / `formatDoneDate`: verify they
  parse RFC 3339 (they should — `Date` parses it natively; the old
  space-separated format was the fragile one).

## Window shell (port of `run.py`)

- `tao` event loop on the main thread; server on a background thread with its
  own tokio runtime; TCP-connect readiness loop before creating the window.
- **Dark titlebar:** `tao` exposes the real `HWND` via `raw-window-handle`,
  so the `FindWindowW` poll-retry hack disappears — call
  `DwmSetWindowAttribute` directly (`DWMWA_USE_IMMERSIVE_DARK_MODE = 20`,
  `DWMWA_CAPTION_COLOR = 35`, caption `COLORREF 0x00140C08` = `#080c14`).
- **F5 / Ctrl-R reload:** `wry`'s `with_initialization_script` runs on every
  navigation automatically, replacing the re-inject-on-`loaded` dance.
- Window icon + exe version info embedded via `build.rs`.

## Testing

- Port the four pytest files (`test_open_tasks`, `test_search_date_filter`,
  `test_task_updates`, `test_waiting_list`) as Rust integration tests:
  in-process axum via `tower::ServiceExt::oneshot`, one temp-file DB per test
  (port of `conftest.py`'s isolation).
- Add migration tests: build a v0 DB with Python-era data (mixed timestamp
  formats, missing columns) and assert the v1 upgrade output.
- JS tests (`npm test`) unchanged.
- `Makefile`: `test-py` → `test-rs` (`cargo test`).

## Packaging & CI

- Repo layout: `Cargo.toml` + `src/` at the repo root (Python is removed at
  cutover, no need for a subdirectory).
- Static CRT (`-C target-feature=+crt-static` via `.cargo/config.toml`) so
  there is no VC++ runtime dependency. Expected artifact: one exe in the
  5–10 MB range instead of a ~60 MB zip.
- `release.yml`: rust toolchain action + `cargo build --release`; publish
  the exe (still zipped as the release asset — browsers/SmartScreen are less
  hostile to zips, and it preserves the "app lives in its own folder"
  convention since `tasks.db` sits next to the exe).
- `build.bat` → `cargo build --release` (or drop it).
- Delete at cutover: `server.py`, `run.py`, `Horizon.spec`, `conftest.py`,
  `tests/*.py`, `requirements*.txt`, `pytest.ini`. Update `README.md`,
  `AGENTS.md`, `Makefile`, `scripts/bump_version.py` (now bumps
  `Cargo.toml`).

## Known constraints

- **WebView2 runtime** is the one external dependency (same as pywebview
  today); preinstalled on Windows 11 and current Windows 10.
- **SmartScreen:** an unsigned downloaded exe still shows "Windows protected
  your PC → More info → Run anyway". Only code signing fixes that; out of
  scope here.
- `wry` also supports macOS (WKWebView) and Linux (WebKitGTK), and
  `--serve` + browser is cross-platform for free, but the packaged/tested
  target remains Windows.

## Phases

1. **Scaffold + storage.** Cargo project, config/paths (DB and log next to
   exe when packaged, project dir in dev), DB module with versioned
   migrations + seeding. Migration tests.
2. **API.** All endpoints in axum with the modernized contract above;
   embedded static serving + `/` with `no-cache` headers; `--serve` mode
   works end to end.
3. **Frontend touch-ups.** New endpoints + boolean/timestamp adjustments in
   `app.js`; click through every flow against `--serve` in a browser.
4. **Tests.** Port the pytest suites to Rust integration tests; wire
   `make test`.
5. **Window shell.** wry/tao window, readiness wait, dark titlebar, reload
   shortcut, icon/version resources.
6. **Cutover.** Rewrite `release.yml`, delete the Python implementation,
   update docs. Verify an existing Python-era `tasks.db` upgrades cleanly.

Python stays untouched and runnable until phase 6, so the old build remains
available throughout.
