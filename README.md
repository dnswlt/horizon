# Horizon

A lightweight, single-user task planner. Upcoming tasks live on the
**horizon** — five lanes for the next five workdays — plus a backlog for
everything undated.

## Quick start

```bash
# First time only: create a virtualenv and install dependencies
python3 -m venv venv
./venv/bin/python -m pip install -r requirements.txt

# Start the server
./venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000>. Tasks are stored in a local `tasks.db`
SQLite file, created automatically on first run.

## Windows: build a double-click app

Produces a single `Horizon.exe`. The end user needs nothing installed — they
double-click it and the app opens in their browser.

To build, you need [Python](https://www.python.org/downloads/) (tick "Add to
PATH" when installing). PyInstaller is pulled in automatically by the script:

```bat
build.bat
```

The app lands at `dist\Horizon.exe` — upload it to a GitHub Release so users
can download it directly.

Notes:

- First launch shows a SmartScreen warning (unsigned app) → **More info → Run
  anyway**. Signing it away costs money; skip it for internal use.
- `tasks.db` is created next to the exe, so put it somewhere writable (not
  `Program Files`). Updates are just a new exe; data is preserved.
