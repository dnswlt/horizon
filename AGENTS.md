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
- **Single user, no bloat.** No accounts, no auth, no teams, no permissions.
  No task-type hierarchies, epics, statuses-of-statuses, or custom fields.
  If a feature smells like enterprise project management, it probably doesn't
  belong here.
- **Lightweight and high-performance.** No SPA framework, no build step, no
  bundler. Vanilla JS + a small FastAPI backend. Keep it that way unless there
  is a compelling reason not to — new dependencies are a cost, not a default.
- **Fast to act.** Drag-and-drop scheduling, inline edit/delete, quick-date
  buttons, keyboard-friendly modals. Every common action should be one or two
  clicks.
- **Nothing is truly lost.** Completing archives; deleting is a soft delete
  (Trash). Both are recoverable. Prefer reversible actions.

## Stack & layout

- **Backend:** `server.py` — FastAPI + SQLite (`tasks.db`). Dependencies are
  pinned in `requirements.txt` (`fastapi`, `uvicorn`, `pydantic`).
- **Frontend:** `static/` — plain `index.html`, `app.js`, `style.css`. No
  framework, no build. The browser loads the files as-is.
- **Data:** a single `tasks.db` SQLite file, created and migrated on startup.

### Key files

| File | Role |
|------|------|
| `server.py` | All API endpoints, DB schema, startup migration, static file serving |
| `static/index.html` | Markup for the three tabs (Board / Archive / Search) and the task modal |
| `static/app.js` | All client logic: rendering, drag-and-drop, modal, search, settings |
| `static/style.css` | All styling (dark theme, CSS custom properties at `:root`) |

## Data model (`tasks` table)

Columns of note: `id` (uuid), `title`, `description`, `due_date`
(`YYYY-MM-DD` or NULL = backlog), `position` (order within a lane),
`completed` with `completed_at`, `deleted_at` (soft delete),
`defer_until` (snooze date), and `created_at`.

Tasks have **no color column**. A card's color is derived on the client from
the first configured `@keyword`/`#keyword` context token in its title or
description (see the `contexts` setting below).

There is also a `settings` key-value table for app preferences, stored as JSON
strings. The `contexts` entry maps each palette color to a context keyword
(e.g. `{"red": "urgent", "blue": "work", ...}`).

## Conventions (important for correct changes)

- **Bump the asset version when you edit `app.js` or `style.css`.** They are
  cache-busted via `?v=N` query strings in `index.html`. If you change a static
  file and forget to bump, the browser serves a stale copy. Bump both to the
  same number.
- **Escape all user-supplied text before inserting into the DOM.** Use the
  `escapeHTML()` helper. The app builds HTML via template strings, so this is
  the XSS boundary — never interpolate raw task text.
- **Persist preferences server-side, not in `localStorage`.** User settings
  (like context keywords) live in the `settings` table via `/api/settings/*`, so
  they survive across browsers and devices. Don't reach for `localStorage` for
  anything that should persist.
- **The schema self-migrates.** `init_db()` adds missing columns on startup via
  `ALTER TABLE`. Add new columns the same way rather than requiring a manual
  migration step.
- **Soft delete, don't hard delete** from user-facing actions. Set `deleted_at`;
  the permanent-delete endpoint is only for emptying Trash.

## Running

First-time setup (creates the virtualenv and installs dependencies):

```bash
python3 -m venv venv
./venv/bin/python -m pip install -r requirements.txt
```

Run the server:

```bash
./venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000 --reload
```

Then open <http://127.0.0.1:8000>. The `tasks.db` SQLite file is created and
seeded automatically on first run. `--reload` picks up backend edits; for
frontend edits, hard-refresh the browser (and remember the `?v=N` bump).
