"""Tests for the Waiting-for list (GTD-style park with no wake date)."""


def _titles(client, path):
    res = client.get(path)
    assert res.status_code == 200, res.text
    return [t["title"] for t in res.json()]


def test_wait_moves_task_off_board_into_waiting_list(client, make_task):
    tid = make_task(title="Chase invoice", due_date="2026-07-10")

    res = client.put(f"/api/tasks/{tid}", json={"waiting": True})
    assert res.status_code == 200, res.text
    task = res.json()

    # Parked: stamped, and its board placement / snooze cleared.
    assert task["waiting_since"] is not None
    assert task["due_date"] is None
    assert task["defer_until"] is None

    # Gone from the board, present on the waiting list.
    assert "Chase invoice" not in _titles(client, "/api/tasks")
    assert "Chase invoice" in _titles(client, "/api/tasks/waiting")


def test_unwait_returns_task_to_the_board(client, make_task):
    tid = make_task(title="Chase invoice")
    client.put(f"/api/tasks/{tid}", json={"waiting": True})

    res = client.put(f"/api/tasks/{tid}", json={"waiting": False})
    assert res.status_code == 200, res.text
    assert res.json()["waiting_since"] is None

    assert "Chase invoice" in _titles(client, "/api/tasks")
    assert "Chase invoice" not in _titles(client, "/api/tasks/waiting")


def test_waiting_list_is_oldest_first(client, make_task):
    # Stamp two tasks with explicit waiting_since so ordering is deterministic.
    old = make_task(title="Older")
    new = make_task(title="Newer")
    conn = __import__("server").get_db_connection()
    conn.execute("UPDATE tasks SET waiting_since = ? WHERE id = ?", ("2026-01-01T00:00:00Z", old))
    conn.execute("UPDATE tasks SET waiting_since = ? WHERE id = ?", ("2026-06-01T00:00:00Z", new))
    conn.commit()
    conn.close()

    assert _titles(client, "/api/tasks/waiting") == ["Older", "Newer"]


def test_completed_waiting_task_drops_off_the_waiting_list(client, make_task):
    tid = make_task(title="Chase invoice")
    client.put(f"/api/tasks/{tid}", json={"waiting": True})
    client.put(f"/api/tasks/{tid}", json={"completed": True})

    assert "Chase invoice" not in _titles(client, "/api/tasks/waiting")
