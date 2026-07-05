"""Tests for the per-task updates log and its effect on search."""


def _updates(client, task_id):
    res = client.get(f"/api/tasks/{task_id}/updates")
    assert res.status_code == 200, res.text
    return res.json()["updates"]


def _system_id(client, task_id):
    return next(u["id"] for u in _updates(client, task_id) if u["kind"] == "system")


# --- creation / system entry ------------------------------------------------

def test_new_task_gets_task_created_system_entry(client, make_task):
    tid = make_task()
    ups = _updates(client, tid)
    assert len(ups) == 1
    assert ups[0]["kind"] == "system"
    assert ups[0]["body"] == "Task created"


def test_seeded_tasks_also_get_a_system_entry(tmp_path, monkeypatch):
    # init_db seeds demo tasks; every one must end up with a system entry so the
    # backfill-after-seed ordering is exercised (regression guard).
    import server
    monkeypatch.setattr(server, "DB_FILE", str(tmp_path / "seeded.db"))
    server.init_db()
    conn = server.get_db_connection()
    tasks_without_system = conn.execute("""
        SELECT COUNT(*) FROM tasks t WHERE NOT EXISTS (
            SELECT 1 FROM task_updates u WHERE u.task_id = t.id AND u.kind = 'system'
        )
    """).fetchone()[0]
    conn.close()
    assert tasks_without_system == 0


# --- posting user updates ---------------------------------------------------

def test_post_user_update(client, make_task):
    tid = make_task()
    res = client.post(f"/api/tasks/{tid}/updates", json={"body": "  did a thing  "})
    assert res.status_code == 200
    assert res.json()["body"] == "did a thing"  # trimmed
    assert res.json()["kind"] == "user"


def test_updates_returned_newest_first(client, make_task):
    tid = make_task()
    client.post(f"/api/tasks/{tid}/updates", json={"body": "first"})
    client.post(f"/api/tasks/{tid}/updates", json={"body": "second"})
    bodies = [u["body"] for u in _updates(client, tid)]
    assert bodies == ["second", "first", "Task created"]


def test_post_empty_body_rejected(client, make_task):
    tid = make_task()
    assert client.post(f"/api/tasks/{tid}/updates", json={"body": "   "}).status_code == 400


def test_post_to_missing_task_404(client):
    assert client.post("/api/tasks/nope/updates", json={"body": "x"}).status_code == 404


# --- editing ----------------------------------------------------------------

def test_edit_preserves_original_timestamp(client, make_task):
    tid = make_task()
    created = client.post(f"/api/tasks/{tid}/updates", json={"body": "before"}).json()
    edited = client.put(f"/api/updates/{created['id']}", json={"body": "after"}).json()
    assert edited["body"] == "after"
    assert edited["created_at"] == created["created_at"]


def test_edit_empty_body_rejected(client, make_task):
    tid = make_task()
    uid = client.post(f"/api/tasks/{tid}/updates", json={"body": "x"}).json()["id"]
    assert client.put(f"/api/updates/{uid}", json={"body": "  "}).status_code == 400


def test_edit_system_entry_forbidden(client, make_task):
    tid = make_task()
    sid = _system_id(client, tid)
    assert client.put(f"/api/updates/{sid}", json={"body": "hack"}).status_code == 403


def test_edit_missing_update_404(client):
    assert client.put("/api/updates/nope", json={"body": "x"}).status_code == 404


# --- deleting ---------------------------------------------------------------

def test_delete_user_update(client, make_task):
    tid = make_task()
    uid = client.post(f"/api/tasks/{tid}/updates", json={"body": "temp"}).json()["id"]
    assert client.delete(f"/api/updates/{uid}").status_code == 200
    assert [u["body"] for u in _updates(client, tid)] == ["Task created"]


def test_delete_system_entry_forbidden(client, make_task):
    tid = make_task()
    sid = _system_id(client, tid)
    assert client.delete(f"/api/updates/{sid}").status_code == 403


def test_delete_missing_update_404(client):
    assert client.delete("/api/updates/nope").status_code == 404


def test_permanent_task_delete_removes_updates(client, make_task):
    tid = make_task()
    client.post(f"/api/tasks/{tid}/updates", json={"body": "note"})
    client.delete(f"/api/tasks/{tid}/permanent")
    assert _updates(client, tid) == []


# --- search integration -----------------------------------------------------

def _search(client, q):
    res = client.get("/api/tasks/search", params={"q": q})
    assert res.status_code == 200, res.text
    return [t["title"] for t in res.json()["tasks"]]


def test_search_matches_update_body(client, make_task):
    make_task(title="Vendor task", description="")
    tid = make_task(title="Vendor task", description="")  # noqa: F841 -- second distinct
    client.post(f"/api/tasks/{tid}/updates", json={"body": "talked to giraffe"})
    assert _search(client, "giraffe") == ["Vendor task"]


def test_search_and_across_fields(client, make_task):
    # One word in the description, another only in an update: both must match.
    tid = make_task(title="T", description="has zebra")
    client.post(f"/api/tasks/{tid}/updates", json={"body": "and a giraffe"})
    assert _search(client, "zebra giraffe") == ["T"]
    assert _search(client, "zebra platypus") == []  # platypus appears nowhere


def test_search_excludes_system_entries(client, make_task):
    make_task(title="Plain", description="nothing special")
    # "created" only appears in the system "Task created" entry -> no match.
    assert _search(client, "created") == []


def test_search_no_duplicate_rows(client, make_task):
    tid = make_task(title="uniqueword", description="uniqueword here")
    client.post(f"/api/tasks/{tid}/updates", json={"body": "uniqueword one"})
    client.post(f"/api/tasks/{tid}/updates", json={"body": "uniqueword two"})
    # Term hits title + description + two updates, but the task appears once.
    assert _search(client, "uniqueword") == ["uniqueword"]


def test_search_case_insensitive_ascii(client, make_task):
    tid = make_task(title="T", description="")
    client.post(f"/api/tasks/{tid}/updates", json={"body": "ALLCAPS word"})
    assert _search(client, "allcaps") == ["T"]
