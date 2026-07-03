import os
import sqlite3
import uuid
from typing import List, Optional
from pydantic import BaseModel
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Database setup
DB_FILE = "tasks.db"

def get_db_connection():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            due_date TEXT, -- YYYY-MM-DD format or NULL for backlog
            position INTEGER NOT NULL,
            completed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()

    # Check if empty to seed
    cursor.execute("SELECT COUNT(*) FROM tasks")
    if cursor.fetchone()[0] == 0:
        # Seed initial tasks
        import datetime
        today = datetime.date.today()
        
        # Helper to find workdays (skipping Saturday/Sunday)
        workdays = []
        curr = today
        while len(workdays) < 5:
            # 0=Mon, 1=Tue, ..., 5=Sat, 6=Sun
            if curr.weekday() < 5:
                workdays.append(curr.strftime("%Y-%m-%d"))
            curr += datetime.timedelta(days=1)

        seed_tasks = [
            # Day 1
            (str(uuid.uuid4()), "Sprint Planning Meeting", "Discuss scope and priorities for the upcoming sprint with the product team.", workdays[0], 0, 0),
            (str(uuid.uuid4()), "Review PR #412", "Code review for the database migration script and user profile updates.", workdays[0], 1, 1),
            # Day 2
            (str(uuid.uuid4()), "Design Session: Drag & Drop UX", "Flesh out UI/UX interactions for the kanban workspace.", workdays[1], 0, 0),
            # Day 3
            (str(uuid.uuid4()), "1on1 with Lead Engineer", "Bi-weekly catch up on career goals, project progress, and blocker cleanup.", workdays[2], 0, 0),
            (str(uuid.uuid4()), "Draft Q3 Roadmap", "Prepare slides for the executive review on product strategy.", workdays[2], 1, 0),
            # Day 4
            (str(uuid.uuid4()), "Refactor Notification Service", "Consolidate email and push notification handlers to reduce latency.", workdays[3], 0, 0),
            # Day 5
            (str(uuid.uuid4()), "Release v1.2.0-rc1", "Prepare release notes, tag git commit, and monitor staging logs.", workdays[4], 0, 0),
            # Backlog
            (str(uuid.uuid4()), "Upgrade Python to 3.12", "Explore performance benefits and new syntax features.", None, 0, 0),
            (str(uuid.uuid4()), "Optimize SQLite index size", "Analyze queries and prune unused indexes to optimize disk usage.", None, 1, 0),
            (str(uuid.uuid4()), "Write integration tests for Auth flow", "Ensure user sessions expire correctly and token renewal behaves as expected.", None, 2, 0),
            (str(uuid.uuid4()), "Revamp onboarding documentation", "Add code examples and quickstart instructions to the wiki.", None, 3, 0),
        ]
        
        cursor.executemany(
            "INSERT INTO tasks (id, title, description, due_date, position, completed) VALUES (?, ?, ?, ?, ?, ?)",
            seed_tasks
        )
        conn.commit()
    conn.close()

# Initialize DB
init_db()

app = FastAPI(title="Task Planner API")

# Pydantic models
class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    due_date: Optional[str] = None # YYYY-MM-DD or None
    position: int

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    due_date: Optional[str] = None
    position: Optional[int] = None
    completed: Optional[bool] = None

class TaskReorderItem(BaseModel):
    id: str
    due_date: Optional[str] = None
    position: int

class TaskReorderRequest(BaseModel):
    tasks: List[TaskReorderItem]

# Endpoints
@app.get("/api/tasks")
def get_tasks():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tasks ORDER BY position ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/api/tasks")
def create_task(task: TaskCreate):
    conn = get_db_connection()
    cursor = conn.cursor()
    task_id = str(uuid.uuid4())
    cursor.execute(
        "INSERT INTO tasks (id, title, description, due_date, position, completed) VALUES (?, ?, ?, ?, ?, 0)",
        (task_id, task.title, task.description, task.due_date, task.position)
    )
    conn.commit()
    cursor.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
    new_task = dict(cursor.fetchone())
    conn.close()
    return new_task

@app.put("/api/tasks/{task_id}")
def update_task(task_id: str, task: TaskUpdate):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
    db_task = cursor.fetchone()
    if not db_task:
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")

    update_fields = []
    params = []
    if task.title is not None:
        update_fields.append("title = ?")
        params.append(task.title)
    if task.description is not None:
        update_fields.append("description = ?")
        params.append(task.description)
    
    # We allow explicit None/null values for due_date
    if "due_date" in task.model_fields_set:
        update_fields.append("due_date = ?")
        params.append(task.due_date)
        
    if task.position is not None:
        update_fields.append("position = ?")
        params.append(task.position)
    if task.completed is not None:
        update_fields.append("completed = ?")
        params.append(1 if task.completed else 0)

    if not update_fields:
        conn.close()
        return dict(db_task)

    params.append(task_id)
    query = f"UPDATE tasks SET {', '.join(update_fields)} WHERE id = ?"
    cursor.execute(query, params)
    conn.commit()
    
    cursor.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
    updated_task = dict(cursor.fetchone())
    conn.close()
    return updated_task

@app.post("/api/tasks/reorder")
def reorder_tasks(payload: TaskReorderRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        for item in payload.tasks:
            cursor.execute(
                "UPDATE tasks SET due_date = ?, position = ? WHERE id = ?",
                (item.due_date, item.position, item.id)
            )
        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        raise HTTPException(status_code=500, detail=str(e))
    conn.close()
    return {"status": "success"}

@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
    db_task = cursor.fetchone()
    if not db_task:
        conn.close()
        raise HTTPException(status_code=404, detail="Task not found")
    
    cursor.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.commit()
    conn.close()
    return {"status": "success"}

# Serve static files
# Ensure static directory exists
os.makedirs("static", exist_ok=True)

# Mount static files at /static
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_index():
    return FileResponse("static/index.html")
