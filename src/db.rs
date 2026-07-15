//! SQLite storage: schema, versioned migrations, and demo seeding.
//!
//! The schema version lives in `PRAGMA user_version`. Version 0 covers both a
//! brand-new database and one created by the retired Python backend (which
//! never set user_version); the v1 migration handles both, so a Python-era
//! `tasks.db` upgrades transparently on first launch.
//!
//! Timestamp columns (`created_at`, `completed_at`, `deleted_at`,
//! `waiting_since`, `maybe_since`) are RFC 3339 UTC with second precision, e.g.
//! "2026-07-11T09:30:00Z", always written from Rust — never via SQL
//! `CURRENT_TIMESTAMP`, which produces the legacy "YYYY-MM-DD HH:MM:SS"
//! format the v1 migration rewrites. Calendar-day columns (`due_date`,
//! `defer_until`) are plain "YYYY-MM-DD" local dates.

use rusqlite::{Connection, Transaction, params};
use serde::Serialize;
use std::path::Path;
use time::format_description::BorrowedFormatItem;
use time::macros::format_description;
use time::{Duration, OffsetDateTime};

const SCHEMA_VERSION: i64 = 2;

const TIMESTAMP_FORMAT: &[BorrowedFormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]Z");
const DATE_FORMAT: &[BorrowedFormatItem<'static>] = format_description!("[year]-[month]-[day]");

/// Current instant as an RFC 3339 UTC string, the format of every timestamp
/// column in the database.
pub fn now_utc() -> String {
    format_timestamp(OffsetDateTime::now_utc())
}

fn format_timestamp(t: OffsetDateTime) -> String {
    t.format(TIMESTAMP_FORMAT).expect("UTC timestamp formatting cannot fail")
}

/// RFC 3339 UTC timestamp `days` days before now (e.g. the board's
/// "completed in the last 7 days" window).
pub fn now_utc_minus_days(days: i64) -> String {
    format_timestamp(OffsetDateTime::now_utc() - Duration::days(days))
}

/// Today as a "YYYY-MM-DD" string in the machine's local timezone. Due dates
/// and snooze dates are local-day concepts, so "has this date arrived?"
/// comparisons must use this, not the UTC date.
pub fn today_local() -> String {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    now.date().format(DATE_FORMAT).expect("date formatting cannot fail")
}

#[derive(Debug, Serialize)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub due_date: Option<String>,
    pub position: i64,
    pub completed: bool,
    pub completed_at: Option<String>,
    pub deleted_at: Option<String>,
    pub defer_until: Option<String>,
    pub waiting_since: Option<String>,
    pub maybe_since: Option<String>,
    pub created_at: Option<String>,
}

impl Task {
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Task> {
        Ok(Task {
            id: row.get("id")?,
            title: row.get("title")?,
            // Nullable in Python-era schemas even though it was always written.
            description: row.get::<_, Option<String>>("description")?.unwrap_or_default(),
            due_date: row.get("due_date")?,
            position: row.get("position")?,
            completed: row.get::<_, i64>("completed")? != 0,
            completed_at: row.get("completed_at")?,
            deleted_at: row.get("deleted_at")?,
            defer_until: row.get("defer_until")?,
            waiting_since: row.get("waiting_since")?,
            maybe_since: row.get("maybe_since")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct TaskUpdate {
    pub id: String,
    pub task_id: String,
    pub body: String,
    pub kind: String,
    pub created_at: Option<String>,
}

impl TaskUpdate {
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<TaskUpdate> {
        Ok(TaskUpdate {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            body: row.get("body")?,
            kind: row.get("kind")?,
            created_at: row.get("created_at")?,
        })
    }
}

/// Open (creating if needed) and migrate the database at `path`.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    let tx = conn.transaction()?;
    if version < 1 {
        migrate_to_v1(&tx)?;
    }
    if version < 2 {
        migrate_to_v2(&tx)?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()
}

/// v1 -> v2: the "Maybe" list. NULL = not on the list.
fn migrate_to_v2(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute("ALTER TABLE tasks ADD COLUMN maybe_since TEXT", [])?;
    Ok(())
}

/// v0 -> v1: create the schema if absent, bring a Python-era database up to
/// the current column set, rewrite legacy "YYYY-MM-DD HH:MM:SS" timestamps to
/// RFC 3339, and seed demo content into an empty tasks table.
fn migrate_to_v1(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            due_date TEXT,      -- YYYY-MM-DD local date, NULL = backlog
            position INTEGER NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            completed_at TEXT,  -- RFC 3339 UTC
            deleted_at TEXT,    -- RFC 3339 UTC, NULL = not in Trash
            defer_until TEXT,   -- snooze date, YYYY-MM-DD local date
            waiting_since TEXT, -- RFC 3339 UTC, NULL = not on the Waiting list
            created_at TEXT     -- RFC 3339 UTC
        );

        -- Key-value settings store (single-user app, so no user scoping).
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Append-only log of updates per task. 'system' entries (e.g. 'Task
        -- created') are generated automatically and are not user-editable;
        -- 'user' entries are the manual notes.
        CREATE TABLE IF NOT EXISTS task_updates (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            body TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'user', -- 'user' | 'system'
            created_at TEXT, -- RFC 3339 UTC
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_updates_task_id ON task_updates(task_id);",
    )?;

    // Columns added over the lifetime of the Python backend; a Python-era DB
    // may predate any of them.
    let columns = table_columns(tx, "tasks")?;
    for (name, decl) in [
        ("completed_at", "completed_at TEXT"),
        ("deleted_at", "deleted_at TEXT"),
        ("defer_until", "defer_until TEXT"),
        ("waiting_since", "waiting_since TEXT"),
    ] {
        if !columns.iter().any(|c| c == name) {
            tx.execute(&format!("ALTER TABLE tasks ADD COLUMN {decl}"), [])?;
        }
    }

    // The Python backend mixed two timestamp formats: SQL CURRENT_TIMESTAMP
    // ("YYYY-MM-DD HH:MM:SS") and Python-written "YYYY-MM-DDTHH:MM:SSZ".
    // Both are UTC, so unifying on RFC 3339 is a pure reformat.
    for (table, col) in [
        ("tasks", "created_at"),
        ("tasks", "completed_at"),
        ("tasks", "deleted_at"),
        ("tasks", "waiting_since"),
        ("task_updates", "created_at"),
    ] {
        tx.execute(
            &format!(
                "UPDATE {table} SET {col} = replace({col}, ' ', 'T') || 'Z'
                 WHERE {col} LIKE '____-__-__ __:__:__'"
            ),
            [],
        )?;
    }

    // Data cleanup: every completed task must have a completed_at timestamp.
    tx.execute(
        "UPDATE tasks SET completed_at = ?1
         WHERE completed = 1 AND (completed_at IS NULL OR completed_at = '')",
        params![now_utc()],
    )?;

    let task_count: i64 = tx.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?;
    if task_count == 0 {
        seed_demo_tasks(tx)?;
    }

    backfill_system_updates(tx)?;
    Ok(())
}

fn table_columns(tx: &Transaction, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

/// Give every task a "Task created" system entry if it lacks one, so each
/// task's log has a floor. Idempotent; covers both seeded and migrated tasks.
fn backfill_system_updates(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO task_updates (id, task_id, body, kind, created_at)
         SELECT lower(hex(randomblob(16))), t.id, 'Task created', 'system',
                COALESCE(t.created_at, ?1)
         FROM tasks t
         WHERE NOT EXISTS (
             SELECT 1 FROM task_updates u WHERE u.task_id = t.id AND u.kind = 'system'
         )",
        params![now_utc()],
    )?;
    Ok(())
}

/// Demo content for a fresh install only; runs exactly once, when the tasks
/// table is empty after creation.
fn seed_demo_tasks(tx: &Transaction) -> rusqlite::Result<()> {
    // The next 5 workdays (skipping Saturday/Sunday), starting today.
    let mut workdays: Vec<String> = Vec::new();
    let mut day = OffsetDateTime::now_local()
        .unwrap_or_else(|_| OffsetDateTime::now_utc())
        .date();
    while workdays.len() < 5 {
        if day.weekday().number_days_from_monday() < 5 {
            workdays.push(day.format(DATE_FORMAT).expect("date formatting cannot fail"));
        }
        day = day.next_day().expect("date out of range");
    }

    let now = OffsetDateTime::now_utc();
    let recent_completed = format_timestamp(now - Duration::days(2));
    let old_completed = format_timestamp(now - Duration::days(10));

    type Seed<'a> = (&'a str, &'a str, Option<&'a str>, i64, bool, Option<&'a str>);
    let seeds: Vec<Seed> = vec![
        // Day 1
        ("Sprint Planning Meeting @work",
         "Discuss scope and priorities for the upcoming sprint with the product team.",
         Some(&workdays[0]), 0, false, None),
        ("Review PR #412 @review",
         "Code review for the database migration script and user profile updates.",
         Some(&workdays[0]), 1, true, Some(&recent_completed)),
        // Day 2
        ("Design Session: Drag & Drop UX @work",
         "Flesh out UI/UX interactions for the kanban workspace.",
         Some(&workdays[1]), 0, false, None),
        // Day 3
        ("1on1 with Lead Engineer @waiting",
         "Bi-weekly catch up on career goals, project progress, and blocker cleanup.",
         Some(&workdays[2]), 0, false, None),
        ("Draft Q3 Roadmap @urgent",
         "Prepare slides for the executive review on product strategy.",
         Some(&workdays[2]), 1, false, None),
        // Day 4
        ("Refactor Notification Service @work",
         "Consolidate email and push notification handlers to reduce latency.",
         Some(&workdays[3]), 0, false, None),
        // Day 5
        ("Release v1.2.0-rc1 @urgent",
         "Prepare release notes, tag git commit, and monitor staging logs.",
         Some(&workdays[4]), 0, false, None),
        // Backlog
        ("Upgrade Python to 3.12 @home",
         "Explore performance benefits and new syntax features.",
         None, 0, false, None),
        ("Optimize SQLite index size @review",
         "Analyze queries and prune unused indexes to optimize disk usage.",
         None, 1, false, None),
        ("Write integration tests for Auth flow @work",
         "Ensure user sessions expire correctly and token renewal behaves as expected.",
         None, 2, false, None),
        ("Revamp onboarding documentation @home",
         "Add code examples and quickstart instructions to the wiki.",
         None, 3, false, None),
        // Archived completed tasks
        ("Clean up deprecated API v1 routes",
         "Deleted unused endpoints and updated API gateway configuration.",
         None, 4, true, Some(&old_completed)),
        ("Fix memory leak in websocket controller @urgent",
         "Identified and patched a listener leak causing heap growth.",
         Some(&workdays[0]), 2, true, Some(&old_completed)),
    ];

    let created_at = now_utc();
    for (title, description, due_date, position, completed, completed_at) in seeds {
        tx.execute(
            "INSERT INTO tasks (id, title, description, due_date, position, completed,
                                completed_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                uuid::Uuid::new_v4().to_string(),
                title,
                description,
                due_date,
                position,
                completed,
                completed_at,
                created_at
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("tasks.db")
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn fresh_db_is_created_seeded_and_versioned() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&db_path(&dir)).unwrap();

        assert_eq!(user_version(&conn), SCHEMA_VERSION);

        let tasks: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(tasks, 13, "demo seed rows");

        // Every task has a 'Task created' system entry.
        let missing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks t WHERE NOT EXISTS
                 (SELECT 1 FROM task_updates u WHERE u.task_id = t.id AND u.kind = 'system')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(missing, 0);

        // All timestamps are RFC 3339 (no legacy space-separated values).
        let legacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE created_at LIKE '% %'
                    OR completed_at LIKE '% %'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0);
    }

    #[test]
    fn opening_twice_does_not_reseed() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_path(&dir);
        {
            let conn = open(&path).unwrap();
            conn.execute("DELETE FROM task_updates", []).unwrap();
            conn.execute("DELETE FROM tasks", []).unwrap();
        }
        let conn = open(&path).unwrap();
        let tasks: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(tasks, 0, "a migrated DB must never be reseeded");
    }

    /// Builds a database exactly as the original Python backend would have
    /// left it: original column set (no completed_at/deleted_at/defer_until/
    /// waiting_since), CURRENT_TIMESTAMP-format timestamps, user_version 0.
    fn make_python_era_db(path: &std::path::Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                due_date TEXT,
                position INTEGER NOT NULL,
                completed INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE task_updates (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                body TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'user',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id)
            );
            INSERT INTO tasks (id, title, description, due_date, position, completed, created_at)
            VALUES
                ('t1', 'Open task', 'desc', '2026-07-13', 0, 0, '2026-07-01 08:00:00'),
                ('t2', 'Done, no completed_at', '', NULL, 1, 1, '2026-07-02 09:30:00');
            INSERT INTO task_updates (id, task_id, body, kind, created_at)
            VALUES ('u1', 't1', 'A user note', 'user', '2026-07-03 10:00:00');",
        )
        .unwrap();
    }

    #[test]
    fn python_era_db_upgrades_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_path(&dir);
        make_python_era_db(&path);

        let conn = open(&path).unwrap();
        assert_eq!(user_version(&conn), SCHEMA_VERSION);

        // No reseeding on top of existing user data.
        let tasks: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(tasks, 2);

        // Missing columns were added and are usable.
        let t1 = conn
            .query_row("SELECT * FROM tasks WHERE id = 't1'", [], Task::from_row)
            .unwrap();
        assert_eq!(t1.deleted_at, None);
        assert_eq!(t1.waiting_since, None);
        assert_eq!(t1.due_date.as_deref(), Some("2026-07-13"));

        // Legacy timestamps were rewritten to RFC 3339.
        assert_eq!(t1.created_at.as_deref(), Some("2026-07-01T08:00:00Z"));
        let note_ts: String = conn
            .query_row("SELECT created_at FROM task_updates WHERE id = 'u1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note_ts, "2026-07-03T10:00:00Z");

        // Completed task got a backfilled RFC 3339 completed_at.
        let t2 = conn
            .query_row("SELECT * FROM tasks WHERE id = 't2'", [], Task::from_row)
            .unwrap();
        assert!(t2.completed);
        let completed_at = t2.completed_at.expect("backfilled");
        assert!(completed_at.ends_with('Z') && completed_at.contains('T'));

        // Both tasks got their 'Task created' system entry, stamped with the
        // (reformatted) task creation time.
        let sys_ts: String = conn
            .query_row(
                "SELECT created_at FROM task_updates WHERE task_id = 't1' AND kind = 'system'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sys_ts, "2026-07-01T08:00:00Z");
    }

    #[test]
    fn timestamp_helpers_produce_expected_formats() {
        let ts = now_utc();
        assert_eq!(ts.len(), 20, "e.g. 2026-07-11T09:30:00Z, got {ts}");
        assert!(ts.ends_with('Z'));
        let today = today_local();
        assert_eq!(today.len(), 10, "e.g. 2026-07-11, got {today}");
    }
}
