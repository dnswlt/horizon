"""Tests for the `after:`/`before:` completion-date bounds on /api/tasks/search.

The search bar's `before:`/`after:` tokens are parsed on the client into
`after`/`before` query params (start-of-period YYYY-MM-DD). Both bounds apply to
completed_at: after -> `>= after`, before -> `< before`.
"""
import uuid

import server


def _add_completed(title, completed_at):
    """Insert a completed task with an explicit completed_at (UTC string)."""
    tid = str(uuid.uuid4())
    conn = server.get_db_connection()
    conn.execute(
        """INSERT INTO tasks (id, title, description, position, completed, completed_at)
           VALUES (?, ?, '', 0, 1, ?)""",
        (tid, title, completed_at),
    )
    conn.commit()
    conn.close()
    return tid


def _titles(client, params):
    res = client.get("/api/tasks/search", params=params)
    assert res.status_code == 200, res.text
    return {t["title"] for t in res.json()["tasks"]}


def test_after_is_inclusive_of_period_start(client):
    _add_completed("jan", "2025-01-01 09:00:00")
    _add_completed("dec", "2024-12-31 23:00:00")
    titles = _titles(client, {"after": "2025-01-01"})
    assert titles == {"jan"}


def test_before_excludes_the_named_day(client):
    # before:2024-07-01 must exclude anything completed on/after Jul 1.
    _add_completed("jun", "2024-06-30 10:00:00")
    _add_completed("jul", "2024-07-01 00:00:01")
    titles = _titles(client, {"before": "2024-07-01"})
    assert titles == {"jun"}


def test_after_and_before_form_a_half_open_range(client):
    # Q1 2025: after:2025-01-01 (client expands after:2025-01) .. before:2025-04-01
    _add_completed("dec24", "2024-12-31 12:00:00")
    _add_completed("jan25", "2025-01-15 12:00:00")
    _add_completed("mar25", "2025-03-31 23:59:59")
    _add_completed("apr25", "2025-04-01 00:00:00")
    titles = _titles(client, {"after": "2025-01-01", "before": "2025-04-01"})
    assert titles == {"jan25", "mar25"}


def test_date_bound_excludes_open_tasks(client, make_task):
    # An open task has NULL completed_at and must never match a date bound.
    make_task(title="open task")
    _add_completed("done task", "2025-06-01 08:00:00")
    titles = _titles(client, {"after": "2025-01-01"})
    assert titles == {"done task"}


def test_date_bound_combines_with_text(client):
    _add_completed("deploy the invoice service", "2025-02-01 08:00:00")
    _add_completed("deploy the auth service", "2025-02-01 08:00:00")
    titles = _titles(client, {"q": "invoice", "after": "2025-01-01"})
    assert titles == {"deploy the invoice service"}


def test_invalid_date_bound_is_ignored(client):
    # A malformed bound (not YYYY-MM-DD) is dropped defensively; with no text and
    # no valid bound, the search short-circuits to empty.
    _add_completed("something", "2025-02-01 08:00:00")
    titles = _titles(client, {"after": "not-a-date"})
    assert titles == set()


def test_empty_query_with_no_bounds_returns_nothing(client):
    _add_completed("something", "2025-02-01 08:00:00")
    titles = _titles(client, {"q": ""})
    assert titles == set()
