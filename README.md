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
./venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8063
```

Then open <http://127.0.0.1:8063>. Tasks are stored in a local `tasks.db`
SQLite file, created automatically on first run.

## Windows: double-click app

Grab the latest `Horizon.exe` from the
[Releases page](https://github.com/dnswlt/horizon/releases) — nothing else to
install. Double-click it and the app opens in its own window, with its own
taskbar icon (a native window via Edge WebView2, which ships with Windows
10/11).

Notes:

- First launch shows a SmartScreen warning (unsigned app) → **More info → Run
  anyway**.
- `tasks.db` is created next to the exe, so put it somewhere writable (not
  `Program Files`). Updates are just a new exe; data is preserved.

### Building it yourself

Releases are built automatically by
[.github/workflows/release.yml](.github/workflows/release.yml) whenever a
`v*.*.*` tag is pushed — most people won't need to build locally. If you do
(e.g. to test a change before tagging a release), you need
[Python](https://www.python.org/downloads/) (tick "Add to PATH" when
installing). PyInstaller is pulled in automatically by the script:

```bat
build.bat
```

The app lands at `dist\Horizon.exe`.
