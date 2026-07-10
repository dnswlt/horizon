"""Tests for /api/tasks/open — the Contexts tab's 'everything open' feed."""


def _titles(client, path):
    res = client.get(path)
    assert res.status_code == 200, res.text
    return [t["title"] for t in res.json()]


def test_open_includes_board_backlog_snoozed_and_waiting(client, make_task):
    scheduled = make_task(title="Scheduled", due_date="2026-07-15")
    make_task(title="Backlog")  # no due date
    snoozed = make_task(title="Snoozed", due_date="2026-07-15")
    waiting = make_task(title="Waiting", due_date="2026-07-15")

    # Snooze one far into the future and park another as waiting.
    client.put(f"/api/tasks/{snoozed}", json={"defer_until": "2099-01-01"})
    client.put(f"/api/tasks/{waiting}", json={"waiting": True})

    titles = _titles(client, "/api/tasks/open")
    assert set(titles) == {"Scheduled", "Backlog", "Snoozed", "Waiting"}
    assert scheduled  # created ok


def test_open_excludes_completed_and_deleted(client, make_task):
    done = make_task(title="Done")
    gone = make_task(title="Gone")
    make_task(title="Alive")

    client.put(f"/api/tasks/{done}", json={"completed": True})
    client.delete(f"/api/tasks/{gone}")

    assert _titles(client, "/api/tasks/open") == ["Alive"]


def test_open_orders_by_due_date_with_backlog_last(client, make_task):
    make_task(title="Backlog")  # undated
    make_task(title="Later", due_date="2026-08-01")
    make_task(title="Sooner", due_date="2026-07-01")

    assert _titles(client, "/api/tasks/open") == ["Sooner", "Later", "Backlog"]
