import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient backed by a throwaway, migrated, empty database.

    server.get_db_connection() reads the module-level DB_FILE at call time, so
    pointing it at a tmp file fully isolates each test. init_db() seeds demo
    tasks into an empty DB, so we wipe those to start from a clean slate.
    """
    db_file = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_FILE", str(db_file))
    server.init_db()

    conn = server.get_db_connection()
    conn.execute("DELETE FROM task_updates")
    conn.execute("DELETE FROM tasks")
    conn.commit()
    conn.close()

    with TestClient(server.app) as c:
        yield c


@pytest.fixture
def make_task(client):
    """Factory that creates a task via the API and returns its id."""
    def _make(title="Task", description="", due_date=None, position=0):
        res = client.post("/api/tasks", json={
            "title": title,
            "description": description,
            "due_date": due_date,
            "position": position,
        })
        assert res.status_code == 200, res.text
        return res.json()["id"]
    return _make
