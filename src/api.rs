//! The Horizon REST API: axum handlers over the SQLite store.
//!
//! State-changing task operations are intent-shaped endpoints (complete,
//! snooze, wait, restore, ...) rather than one omnibus update, so every
//! request body field is meaningful on its own and `null` always means
//! "clear" — there is no "was this key present?" introspection anywhere.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{self, Task, TaskUpdate};
use crate::static_files;

pub struct AppState {
    // A plain mutex around one connection is all a single-user local app
    // needs; requests are short and SQLite serializes writers anyway.
    db: Mutex<Connection>,
}

type SharedState = Arc<AppState>;

/// Error responses are `{"error": "..."}` with a matching status code.
pub struct ApiError(StatusCode, String);

impl ApiError {
    fn not_found(what: &str) -> ApiError {
        ApiError(StatusCode::NOT_FOUND, format!("{what} not found"))
    }
    fn bad_request(msg: &str) -> ApiError {
        ApiError(StatusCode::BAD_REQUEST, msg.to_string())
    }
    fn forbidden(msg: &str) -> ApiError {
        ApiError(StatusCode::FORBIDDEN, msg.to_string())
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> ApiError {
        log::error!("database error: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn success() -> Json<Value> {
    Json(json!({ "status": "success" }))
}

pub fn router(db_conn: Connection) -> Router {
    let state: SharedState = Arc::new(AppState { db: Mutex::new(db_conn) });
    Router::new()
        .route("/", get(static_files::index))
        .route("/static/{*path}", get(static_files::asset))
        .route("/api/settings/contexts", get(get_contexts).put(update_contexts))
        .route("/api/tasks", get(get_board_tasks).post(create_task))
        .route("/api/tasks/open", get(get_open_tasks))
        .route("/api/tasks/waiting", get(get_waiting_tasks))
        .route("/api/tasks/snoozed", get(get_snoozed_tasks))
        .route("/api/tasks/search", get(search_tasks))
        .route("/api/tasks/archive", get(get_archived_tasks))
        .route("/api/tasks/deleted", get(get_deleted_tasks))
        .route("/api/tasks/reorder", post(reorder_tasks))
        .route("/api/tasks/{id}", patch(edit_task).delete(delete_task_soft))
        .route("/api/tasks/{id}/complete", post(complete_task))
        .route("/api/tasks/{id}/snooze", post(snooze_task))
        .route("/api/tasks/{id}/wait", post(wait_task))
        .route("/api/tasks/{id}/restore", post(restore_task))
        .route("/api/tasks/{id}/permanent", delete(delete_task_permanent))
        .route("/api/tasks/{id}/updates", get(get_task_updates).post(create_task_update))
        .route("/api/updates/{id}", put(edit_task_update).delete(delete_task_update))
        .with_state(state)
}

/// Open the database and serve the app, blocking the calling thread. Runs its
/// own tokio runtime so the caller can be either `main` (headless `--serve`
/// mode) or a background thread behind the WebView2 window.
pub fn run_blocking(db_file: &Path, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let conn = db::open(db_file)?;
    let app = router(conn);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        log::info!("serving on http://{addr}");
        axum::serve(listener, app).await
    })?;
    Ok(())
}

// ===== Helpers =====

fn query_tasks<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> rusqlite::Result<Vec<Task>> {
    let mut stmt = conn.prepare(sql)?;
    let tasks = stmt.query_map(params, Task::from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tasks)
}

fn get_task(conn: &Connection, id: &str) -> ApiResult<Task> {
    conn.query_row("SELECT * FROM tasks WHERE id = ?1", params![id], Task::from_row)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ApiError::not_found("Task"),
            other => other.into(),
        })
}

/// "YYYY-MM-DD", strictly.
fn is_iso_date(s: &str) -> bool {
    s.len() == 10
        && s.bytes()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() })
}

// ===== Settings =====

/// Maps each palette color to a context keyword. A task is painted a color
/// when its title/description mentions the matching @keyword. Empty string =
/// that color is unused.
#[derive(Serialize, Deserialize)]
struct Contexts {
    red: String,
    green: String,
    blue: String,
    yellow: String,
    purple: String,
}

impl Default for Contexts {
    fn default() -> Contexts {
        Contexts {
            red: "urgent".into(),
            green: "review".into(),
            blue: "work".into(),
            yellow: String::new(), // "waiting" retired: it's a real state now
            purple: "home".into(),
        }
    }
}

async fn get_contexts(State(state): State<SharedState>) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = 'contexts'", [], |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;

    // Merge stored values over the defaults so missing keys fall back
    // gracefully (older DBs may have stored a subset).
    let mut merged = serde_json::to_value(Contexts::default()).unwrap();
    if let Some(stored) = stored
        && let Ok(Value::Object(overrides)) = serde_json::from_str::<Value>(&stored)
    {
        merged.as_object_mut().unwrap().extend(overrides);
    }
    Ok(Json(merged))
}

async fn update_contexts(
    State(state): State<SharedState>,
    Json(contexts): Json<Contexts>,
) -> ApiResult<Json<Contexts>> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('contexts', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![serde_json::to_string(&contexts).unwrap()],
    )?;
    Ok(Json(contexts))
}

// ===== Task lists =====

/// The board: active tasks plus tasks completed in the last 7 days (not
/// deleted). Snoozed tasks (defer_until in the future) are excluded; once
/// defer_until is today or past they resurface here and the client flags
/// them. Waiting tasks live on their own list.
async fn get_board_tasks(State(state): State<SharedState>) -> ApiResult<Json<Vec<Task>>> {
    let week_ago = db::now_utc_minus_days(7);
    let conn = state.db.lock().unwrap();
    let tasks = query_tasks(
        &conn,
        "SELECT * FROM tasks
         WHERE (completed = 0 OR (completed = 1 AND completed_at >= ?1))
           AND deleted_at IS NULL
           AND (defer_until IS NULL OR defer_until <= ?2)
           AND waiting_since IS NULL
         ORDER BY position ASC",
        params![week_ago, db::today_local()],
    )?;
    Ok(Json(tasks))
}

/// Every open task, for the Contexts tab's "everything on my plate" overview.
/// Unlike the board this applies no horizon filtering: snoozed, waiting,
/// backlog and scheduled tasks are all included. Ordered by due date (undated
/// backlog last) so each context bucket reads soonest-first.
async fn get_open_tasks(State(state): State<SharedState>) -> ApiResult<Json<Vec<Task>>> {
    let conn = state.db.lock().unwrap();
    let tasks = query_tasks(
        &conn,
        "SELECT * FROM tasks
         WHERE completed = 0 AND deleted_at IS NULL
         ORDER BY due_date IS NULL, due_date ASC, position ASC",
        [],
    )?;
    Ok(Json(tasks))
}

/// "Waiting For" list: parked tasks blocked on someone else, no wake date.
/// Oldest first, so the stalest (most in need of a nudge) sit on top.
async fn get_waiting_tasks(State(state): State<SharedState>) -> ApiResult<Json<Vec<Task>>> {
    let conn = state.db.lock().unwrap();
    let tasks = query_tasks(
        &conn,
        "SELECT * FROM tasks
         WHERE completed = 0 AND deleted_at IS NULL AND waiting_since IS NOT NULL
         ORDER BY waiting_since ASC",
        [],
    )?;
    Ok(Json(tasks))
}

/// Tasks snoozed into the future, soonest to return first.
async fn get_snoozed_tasks(State(state): State<SharedState>) -> ApiResult<Json<Vec<Task>>> {
    let conn = state.db.lock().unwrap();
    let tasks = query_tasks(
        &conn,
        "SELECT * FROM tasks
         WHERE completed = 0 AND deleted_at IS NULL
           AND defer_until IS NOT NULL AND defer_until > ?1
         ORDER BY defer_until ASC",
        params![db::today_local()],
    )?;
    Ok(Json(tasks))
}

// ===== Search =====

fn default_true() -> bool {
    true
}
fn default_search_limit() -> i64 {
    100
}

#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
    #[serde(default = "default_true")]
    include_done: bool,
    #[serde(default)]
    after: String,
    #[serde(default)]
    before: String,
    #[serde(default = "default_search_limit")]
    limit: i64,
}

/// Escape LIKE wildcards so a search term is matched literally.
fn like_escape(term: &str) -> String {
    term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Each whitespace-separated word must appear in the title, the description,
/// or any of the task's user updates (case-insensitive; SQLite's LIKE folds
/// ASCII case). System updates are excluded so they never match. Deleted
/// tasks are never returned.
///
/// `after`/`before` are start-of-period dates (YYYY-MM-DD) bounding
/// completed_at: after -> `>= after`, before -> `< before`. Open tasks have a
/// NULL completed_at, so any date bound implicitly restricts the result to
/// completed tasks. Invalid values are ignored defensively; the client's
/// query parser produces them from `after:`/`before:` tokens.
async fn search_tasks(
    State(state): State<SharedState>,
    Query(p): Query<SearchParams>,
) -> ApiResult<Json<Value>> {
    let words: Vec<&str> = p.q.split_whitespace().collect();
    let after = Some(p.after.as_str()).filter(|s| is_iso_date(s));
    let before = Some(p.before.as_str()).filter(|s| is_iso_date(s));
    if words.is_empty() && after.is_none() && before.is_none() {
        return Ok(Json(json!({ "tasks": [] })));
    }

    let mut clauses = vec!["deleted_at IS NULL".to_string()];
    let mut bind: Vec<String> = Vec::new();
    if !p.include_done {
        clauses.push("completed = 0".to_string());
    }
    if let Some(after) = after {
        clauses.push("completed_at >= ?".to_string());
        bind.push(after.to_string());
    }
    if let Some(before) = before {
        clauses.push("completed_at < ?".to_string());
        bind.push(before.to_string());
    }
    for word in words {
        clauses.push(
            "(title LIKE ? ESCAPE '\\'
              OR description LIKE ? ESCAPE '\\'
              OR EXISTS (
                  SELECT 1 FROM task_updates u
                  WHERE u.task_id = tasks.id AND u.kind = 'user'
                    AND u.body LIKE ? ESCAPE '\\'
              ))"
            .to_string(),
        );
        let like = format!("%{}%", like_escape(word));
        bind.extend([like.clone(), like.clone(), like]);
    }

    // `limit` is a typed integer, so inlining it is safe and keeps the bind
    // list homogeneous.
    let sql = format!(
        "SELECT * FROM tasks
         WHERE {}
         ORDER BY COALESCE(completed_at, created_at) DESC
         LIMIT {}",
        clauses.join(" AND "),
        p.limit.max(0)
    );

    let conn = state.db.lock().unwrap();
    let tasks = query_tasks(&conn, &sql, rusqlite::params_from_iter(bind))?;
    Ok(Json(json!({ "tasks": tasks })))
}

// ===== Archive / Trash =====

fn default_page_limit() -> i64 {
    50
}

#[derive(Deserialize)]
struct PageParams {
    #[serde(default = "default_page_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}

/// Fetch limit+1 rows to learn whether another page exists.
fn page_of_tasks(
    conn: &Connection,
    where_order: &str,
    p: &PageParams,
) -> rusqlite::Result<Value> {
    let limit = p.limit.max(0);
    let sql = format!("SELECT * FROM tasks WHERE {where_order} LIMIT ?1 OFFSET ?2");
    let mut tasks = query_tasks(conn, &sql, params![limit + 1, p.offset.max(0)])?;
    let has_more = tasks.len() as i64 > limit;
    tasks.truncate(limit as usize);
    Ok(json!({ "tasks": tasks, "has_more": has_more }))
}

/// Paginated completed tasks (not deleted), newest first.
async fn get_archived_tasks(
    State(state): State<SharedState>,
    Query(p): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let page = page_of_tasks(
        &conn,
        "completed = 1 AND deleted_at IS NULL ORDER BY completed_at DESC",
        &p,
    )?;
    Ok(Json(page))
}

/// Paginated soft-deleted tasks (Trash), most recently deleted first.
async fn get_deleted_tasks(
    State(state): State<SharedState>,
    Query(p): Query<PageParams>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let page = page_of_tasks(&conn, "deleted_at IS NOT NULL ORDER BY deleted_at DESC", &p)?;
    Ok(Json(page))
}

// ===== Task creation / editing =====

#[derive(Deserialize)]
struct TaskCreate {
    title: String,
    #[serde(default)]
    description: String,
    due_date: Option<String>,
    position: i64,
}

async fn create_task(
    State(state): State<SharedState>,
    Json(body): Json<TaskCreate>,
) -> ApiResult<Json<Task>> {
    let conn = state.db.lock().unwrap();
    let task_id = uuid::Uuid::new_v4().to_string();
    let now = db::now_utc();
    conn.execute(
        "INSERT INTO tasks (id, title, description, due_date, position, completed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        params![task_id, body.title, body.description, body.due_date, body.position, now],
    )?;
    conn.execute(
        "INSERT INTO task_updates (id, task_id, body, kind, created_at)
         VALUES (?1, ?2, 'Task created', 'system', ?3)",
        params![uuid::Uuid::new_v4().to_string(), task_id, now],
    )?;
    Ok(Json(get_task(&conn, &task_id)?))
}

/// Content edits. All fields are required — the edit dialog always submits
/// the complete set; `due_date: null` moves the task to the backlog.
#[derive(Deserialize)]
struct TaskEdit {
    title: String,
    description: String,
    due_date: Option<String>,
}

async fn edit_task(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<TaskEdit>,
) -> ApiResult<Json<Task>> {
    if let Some(d) = &body.due_date
        && !is_iso_date(d)
    {
        return Err(ApiError::bad_request("due_date must be YYYY-MM-DD"));
    }
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    // Scheduling onto a real day acknowledges any snooze/resurfaced state.
    conn.execute(
        "UPDATE tasks SET title = ?1, description = ?2, due_date = ?3,
             defer_until = CASE WHEN ?3 IS NOT NULL THEN NULL ELSE defer_until END
         WHERE id = ?4",
        params![body.title, body.description, body.due_date, id],
    )?;
    Ok(Json(get_task(&conn, &id)?))
}

// ===== Task state transitions =====

#[derive(Deserialize)]
struct CompleteBody {
    completed: bool,
}

/// Complete or reopen a task; completed_at tracks the transition.
async fn complete_task(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<CompleteBody>,
) -> ApiResult<Json<Task>> {
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    let completed_at = body.completed.then(db::now_utc);
    conn.execute(
        "UPDATE tasks SET completed = ?1, completed_at = ?2 WHERE id = ?3",
        params![body.completed, completed_at, id],
    )?;
    Ok(Json(get_task(&conn, &id)?))
}

#[derive(Deserialize)]
struct SnoozeBody {
    until: Option<String>,
}

/// Snooze a task until a future date (it leaves the board and waits in the
/// Snoozed strip), or clear the snooze with `until: null` — which both
/// un-snoozes early and dismisses the "resurfaced" state. Snoozing also
/// takes the task off the board, so any due date is cleared.
async fn snooze_task(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<SnoozeBody>,
) -> ApiResult<Json<Task>> {
    if let Some(until) = &body.until
        && !is_iso_date(until)
    {
        return Err(ApiError::bad_request("until must be YYYY-MM-DD"));
    }
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    match &body.until {
        Some(until) => conn.execute(
            "UPDATE tasks SET defer_until = ?1, due_date = NULL WHERE id = ?2",
            params![until, id],
        )?,
        None => conn.execute("UPDATE tasks SET defer_until = NULL WHERE id = ?1", params![id])?,
    };
    Ok(Json(get_task(&conn, &id)?))
}

#[derive(Deserialize)]
struct WaitBody {
    waiting: bool,
}

/// Park a task on the "Waiting For" list (GTD): no wake date by design —
/// reviewed, not alarmed. Entering stamps waiting_since and clears any board
/// placement / snooze; leaving just clears the stamp.
async fn wait_task(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<WaitBody>,
) -> ApiResult<Json<Task>> {
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    if body.waiting {
        conn.execute(
            "UPDATE tasks SET waiting_since = ?1, due_date = NULL, defer_until = NULL
             WHERE id = ?2",
            params![db::now_utc(), id],
        )?;
    } else {
        conn.execute("UPDATE tasks SET waiting_since = NULL WHERE id = ?1", params![id])?;
    }
    Ok(Json(get_task(&conn, &id)?))
}

/// Restore a task from the Trash.
async fn restore_task(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Task>> {
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    conn.execute("UPDATE tasks SET deleted_at = NULL WHERE id = ?1", params![id])?;
    Ok(Json(get_task(&conn, &id)?))
}

// ===== Reorder =====

#[derive(Deserialize)]
struct ReorderItem {
    id: String,
    due_date: Option<String>,
    position: i64,
}

#[derive(Deserialize)]
struct ReorderBody {
    tasks: Vec<ReorderItem>,
}

/// Bulk drag-and-drop placement. Dragging onto a real day also clears any
/// snooze/resurfaced state.
async fn reorder_tasks(
    State(state): State<SharedState>,
    Json(body): Json<ReorderBody>,
) -> ApiResult<Json<Value>> {
    let mut conn = state.db.lock().unwrap();
    let tx = conn.transaction().map_err(ApiError::from)?;
    for item in &body.tasks {
        tx.execute(
            "UPDATE tasks SET due_date = ?1, position = ?2,
                 defer_until = CASE WHEN ?1 IS NOT NULL THEN NULL ELSE defer_until END
             WHERE id = ?3",
            params![item.due_date, item.position, item.id],
        )?;
    }
    tx.commit().map_err(ApiError::from)?;
    Ok(success())
}

// ===== Delete =====

/// Soft delete: move to Trash (recoverable via restore).
async fn delete_task_soft(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    conn.execute(
        "UPDATE tasks SET deleted_at = ?1 WHERE id = ?2",
        params![db::now_utc(), id],
    )?;
    Ok(success())
}

/// Permanently delete a task and its update log (emptying Trash only).
async fn delete_task_permanent(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    conn.execute("DELETE FROM task_updates WHERE task_id = ?1", params![id])?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
    Ok(success())
}

// ===== Task updates (the per-task log) =====

/// Full update log for a task, newest first.
async fn get_task_updates(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT * FROM task_updates WHERE task_id = ?1 ORDER BY created_at DESC, rowid DESC",
    )?;
    let updates = stmt
        .query_map(params![id], TaskUpdate::from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({ "updates": updates })))
}

#[derive(Deserialize)]
struct UpdateBody {
    body: String,
}

async fn create_task_update(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
    Json(update): Json<UpdateBody>,
) -> ApiResult<Json<TaskUpdate>> {
    let body = update.body.trim();
    if body.is_empty() {
        return Err(ApiError::bad_request("Update body cannot be empty"));
    }
    let conn = state.db.lock().unwrap();
    get_task(&conn, &id)?;
    let update_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO task_updates (id, task_id, body, kind, created_at)
         VALUES (?1, ?2, ?3, 'user', ?4)",
        params![update_id, id, body, db::now_utc()],
    )?;
    let row = conn.query_row(
        "SELECT * FROM task_updates WHERE id = ?1",
        params![update_id],
        TaskUpdate::from_row,
    )?;
    Ok(Json(row))
}

fn get_update_kind(conn: &Connection, id: &str) -> ApiResult<String> {
    conn.query_row("SELECT kind FROM task_updates WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => ApiError::not_found("Update"),
            other => other.into(),
        })
}

/// Edit a user update's body. The original timestamp is preserved and system
/// entries cannot be edited.
async fn edit_task_update(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
    Json(update): Json<UpdateBody>,
) -> ApiResult<Json<TaskUpdate>> {
    let body = update.body.trim();
    if body.is_empty() {
        return Err(ApiError::bad_request("Update body cannot be empty"));
    }
    let conn = state.db.lock().unwrap();
    if get_update_kind(&conn, &id)? != "user" {
        return Err(ApiError::forbidden("System updates cannot be edited"));
    }
    conn.execute("UPDATE task_updates SET body = ?1 WHERE id = ?2", params![body, id])?;
    let row = conn.query_row(
        "SELECT * FROM task_updates WHERE id = ?1",
        params![id],
        TaskUpdate::from_row,
    )?;
    Ok(Json(row))
}

/// Hard-delete a user update. System entries are protected.
async fn delete_task_update(
    State(state): State<SharedState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let conn = state.db.lock().unwrap();
    if get_update_kind(&conn, &id)? != "user" {
        return Err(ApiError::forbidden("System updates cannot be deleted"));
    }
    conn.execute("DELETE FROM task_updates WHERE id = ?1", params![id])?;
    Ok(success())
}
