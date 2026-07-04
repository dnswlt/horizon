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
