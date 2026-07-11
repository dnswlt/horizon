# AGENTS.md — Horizon

High-level orientation for AI agents working on **Horizon**, a lightweight
personal task planner.

## What this is

A fast, single-user task manager. One person, one board, one SQLite file. It is
deliberately minimal — the whole point is to avoid the weight that makes tools
like Jira and Trello tiring to use.

## Product principles (read before changing UX)

- **The horizon is the core metaphor.** The Board shows five lanes — the next
  five *workdays* (weekends skipped) — plus a Backlog for anything undated.
  Tasks flow right-to-left toward "today." Keep this front and center; don't
  bury it behind views or filters.
- **Snooze gets what you can't act on yet out of the way.** So the horizon only
  ever shows what's actually actionable now. A task with a future `defer_until`
  leaves the board and waits in the Snoozed strip; on that date it resurfaces
  (marked "Snooze ended"). Un-snoozing returns it immediately.
- **Single user, no bloat.** No accounts, no auth, no teams, no permissions.
  No task-type hierarchies, epics, statuses-of-statuses, or custom fields.
  If a feature smells like enterprise project management, it probably doesn't
  belong here.
- **Lightweight and high-performance.** No SPA framework, no build step, no
  bundler. Vanilla JS + a small Rust backend compiled into a single exe. Keep
  it that way unless there is a compelling reason not to — new dependencies
  are a cost, not a default.
- **Fast to act.** Drag-and-drop scheduling, inline edit/delete, quick-date
  buttons, keyboard-friendly modals. Every common action should be one or two
  clicks.
- **Nothing is truly lost.** Completing archives; deleting is a soft delete
  (Trash). Both are recoverable. Prefer reversible actions.

## Stack & layout

- **Backend:** Rust — axum (HTTP) + rusqlite (`tasks.db`), one binary with
  two modes: a native WebView2 window (default; the pinned-taskbar app) and
  `--serve` for classic backend + browser use.
- **Frontend:** `static/` — plain `index.html`, `app.js`, `core.js`,
  `style.css`. No framework, no bundler. `app.js` is a native ES module that
  imports pure helpers from `core.js`. Release builds embed `static/` into
  the exe (rust-embed); debug builds serve it from disk, so frontend edits
  only need a browser reload.
- **Data:** a single `tasks.db` SQLite file, created and migrated on startup.

### Key files

| File | Role |
|------|------|
| `src/api.rs` | All API endpoints (axum router + handlers) |
| `src/db.rs` | Schema, versioned migrations (`PRAGMA user_version`), demo seeding, timestamp helpers |
| `src/main.rs` | Arg parsing, logging, server thread + mode dispatch |
| `src/window.rs` | Native window shell (wry/tao, dark titlebar, F5 reload) |
| `src/static_files.rs` | Embedded (release) / on-disk (debug) asset serving |
| `tests/api.rs` | API integration tests (in-process axum over a temp DB) |
| `static/index.html` | Markup for the tabs (Board / Archive / Search) and the task modal |
| `static/app.js` | DOM-bound client logic: rendering, drag-and-drop, modal, search, settings |
| `static/core.js` | Pure, DOM-free, unit-tested helpers (date/format, query parsing, `escapeHTML`) |
| `static/style.css` | All styling (dark theme, CSS custom properties at `:root`) |
| `tests/js/core.test.js` | Frontend unit tests for `core.js` (`node --test`) |

## Data model (`tasks` table)

Columns of note: `id` (uuid), `title`, `description`, `due_date`
(`YYYY-MM-DD` or NULL = backlog), `position` (order within a lane),
`completed` with `completed_at`, `deleted_at` (soft delete),
`defer_until` (snooze date), `waiting_since` (Waiting-for list), and
`created_at`.

**Formats:** timestamp columns are RFC 3339 UTC (`2026-07-11T09:30:00Z`),
always written from Rust (`db::now_utc()`), never via SQL
`CURRENT_TIMESTAMP`. Calendar-day columns (`due_date`, `defer_until`) are
plain local `YYYY-MM-DD`; "has this date arrived?" comparisons use
`db::today_local()`. In JSON, `completed` is a real boolean.

Tasks have **no color column**. A card's color is derived on the client from
the first configured `@keyword` context token in its title or description (see
the `contexts` setting below). Tag parsing lives in one place —
`extractContexts()` in `core.js`, which `deriveColor()` reuses. Only `@` marks a
context, and only when it starts the text or follows a non-word character, so
issue/PR refs like `#412` and email addresses like `me@example.com` are **not**
treated as tags.

There is also a `settings` key-value table for app preferences, stored as JSON
strings. The `contexts` entry maps each palette color to a context keyword
(e.g. `{"red": "urgent", "blue": "work", ...}`), and a `task_updates` table
holding each task's append-only log (`user` notes plus protected `system`
entries).

## API shape (important for correct changes)

Task state changes are **intent endpoints**, not one omnibus update:
`POST /api/tasks/{id}/complete|snooze|wait|restore`, plus
`PATCH /api/tasks/{id}` for content edits (title/description/due_date — the
full set every time, `due_date: null` = backlog). Every body field is
meaningful on its own and `null` always means "clear"; don't add handlers
that need "was this key present?" introspection. Business rules live with
the endpoint: scheduling clears a snooze, snoozing/waiting clears the due
date, completing stamps `completed_at`.

## Conventions (important for correct changes)

- **Edit a static file → run `make bump-version`.** Assets are cache-busted
  with `?v=N`; the script bumps every marker across `index.html` and `app.js`
  in lockstep (so `core.js` moves too). Forget it and the browser serves a
  stale copy. Don't hand-edit the numbers.
- **Escape all user-supplied text before inserting into the DOM.** Use the
  `escapeHTML()` helper. The app builds HTML via template strings, so this is
  the XSS boundary — never interpolate raw task text.
- **Persist preferences server-side, not in `localStorage`.** User settings
  (like context keywords) live in the `settings` table via `/api/settings/*`, so
  they survive across browsers and devices. Don't reach for `localStorage` for
  anything that should persist.
- **Schema changes are versioned migrations.** Bump `SCHEMA_VERSION` in
  `src/db.rs` and add a step to `migrate()`; migrations run in a transaction
  on startup. Version 0 also covers databases created by the retired Python
  backend, so never assume a fresh DB.
- **Soft delete, don't hard delete** from user-facing actions. Set `deleted_at`;
  the permanent-delete endpoint is only for emptying Trash.
- **Pure logic in `core.js`; `app.js` owns the DOM.** DOM-free helpers
  (parsing, formatting, date math) live in `core.js` and get unit tests. Reuse
  shared helpers over re-rolling: `apiFetch`/`postTaskAction`/`editTaskContent`
  (requests), `ICONS` (button SVGs), `core.js` (date/format/parse).

## Running

```bash
cargo run -- --serve   # dev server at http://127.0.0.1:8063
cargo run              # dev build of the windowed app
```

The `tasks.db` SQLite file is created and seeded automatically on first run
(repo root in debug builds, next to the exe in release builds). Debug builds
serve `static/` from disk; hard-refresh the browser after frontend edits (and
remember the `?v=N` bump).

**Windows packaging:** `cargo build --release` produces a single
self-contained `target/release/Horizon.exe` (static assets embedded, MSVC C
runtime statically linked, icon/version via `build.rs`). Releases are built
by `.github/workflows/release.yml` on `v*.*.*` tags.

## Tests

- **Backend:** `cargo test` — DB/migration unit tests in `src/db.rs` and API
  integration tests in `tests/api.rs`, which drive the axum router in-process
  against a throwaway per-test SQLite file (demo seed wiped), so tests never
  touch the real `tasks.db`.
- **Frontend:** `core.js` is unit-tested with Node's built-in runner (no
  dependencies): `npm test`.

**`make test` runs both suites** and is the single command to check everything.
