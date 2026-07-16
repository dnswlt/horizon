//! API integration tests: the axum router driven in-process over a
//! throwaway, migrated, empty database (port of the pytest suites).

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

/// A router backed by a throwaway database. `db::open` seeds demo tasks into
/// a fresh DB, so we wipe those to start each test from a clean slate. The
/// direct `conn` lets tests set up rows the API deliberately can't create
/// (e.g. explicit timestamps).
struct TestApp {
    router: Router,
    conn: rusqlite::Connection,
    _dir: tempfile::TempDir,
}

fn test_app() -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let db_file = dir.path().join("test.db");
    let conn = horizon::db::open(&db_file).unwrap();
    conn.execute("DELETE FROM task_updates", []).unwrap();
    conn.execute("DELETE FROM tasks", []).unwrap();
    let router = horizon::api::router(horizon::db::open(&db_file).unwrap());
    TestApp { router, conn, _dir: dir }
}

impl TestApp {
    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(path);
        let body = match body {
            Some(v) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let resp =
            self.router.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.request("GET", path, None).await
    }

    /// GET a task-list endpoint and return the titles in order.
    async fn titles(&self, path: &str) -> Vec<String> {
        let (status, body) = self.get(path).await;
        assert_eq!(status, StatusCode::OK, "GET {path}: {body}");
        let list = body.as_array().unwrap_or_else(|| body["tasks"].as_array().unwrap());
        list.iter().map(|t| t["title"].as_str().unwrap().to_string()).collect()
    }

    /// Create a task via the API and return its id.
    async fn make_task(&self, title: &str, due_date: Option<&str>) -> String {
        let (status, body) = self
            .request(
                "POST",
                "/api/tasks",
                Some(json!({
                    "title": title, "description": "", "due_date": due_date, "position": 0
                })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "create task: {body}");
        body["id"].as_str().unwrap().to_string()
    }

    /// Insert a completed task with an explicit completed_at timestamp.
    fn add_completed(&self, title: &str, completed_at: &str) {
        self.conn
            .execute(
                "INSERT INTO tasks (id, title, description, position, completed, completed_at)
                 VALUES (?1, ?2, '', 0, 1, ?3)",
                rusqlite::params![uuid_like(title), title, completed_at],
            )
            .unwrap();
    }

    async fn updates(&self, task_id: &str) -> Vec<Value> {
        let (status, body) = self.get(&format!("/api/tasks/{task_id}/updates")).await;
        assert_eq!(status, StatusCode::OK);
        body["updates"].as_array().unwrap().clone()
    }

    async fn system_update_id(&self, task_id: &str) -> String {
        self.updates(task_id)
            .await
            .iter()
            .find(|u| u["kind"] == "system")
            .expect("system entry")["id"]
            .as_str()
            .unwrap()
            .to_string()
    }
}

/// Deterministic unique-enough id for direct inserts.
fn uuid_like(seed: &str) -> String {
    format!("test-{seed}-{}", uuid::Uuid::new_v4())
}

async fn search_titles(app: &TestApp, query: &str) -> Vec<String> {
    app.titles(&format!("/api/tasks/search?{query}")).await
}

// ===== Waiting-for list (park with no wake date) =====

#[tokio::test]
async fn wait_moves_task_off_board_into_waiting_list() {
    let app = test_app();
    let tid = app.make_task("Chase invoice", Some("2026-07-10")).await;

    let (status, task) = app
        .request("POST", &format!("/api/tasks/{tid}/wait"), Some(json!({"waiting": true})))
        .await;
    assert_eq!(status, StatusCode::OK, "{task}");

    // Parked: stamped, and its board placement / snooze cleared.
    assert!(task["waiting_since"].is_string());
    assert!(task["due_date"].is_null());
    assert!(task["defer_until"].is_null());

    // Gone from the board, present on the waiting list.
    assert!(!app.titles("/api/tasks").await.contains(&"Chase invoice".to_string()));
    assert!(app.titles("/api/tasks/waiting").await.contains(&"Chase invoice".to_string()));
}

#[tokio::test]
async fn unwait_returns_task_to_the_board() {
    let app = test_app();
    let tid = app.make_task("Chase invoice", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/wait"), Some(json!({"waiting": true}))).await;

    let (status, task) = app
        .request("POST", &format!("/api/tasks/{tid}/wait"), Some(json!({"waiting": false})))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(task["waiting_since"].is_null());

    assert!(app.titles("/api/tasks").await.contains(&"Chase invoice".to_string()));
    assert!(app.titles("/api/tasks/waiting").await.is_empty());
}

#[tokio::test]
async fn waiting_list_is_oldest_first() {
    let app = test_app();
    let old = app.make_task("Older", None).await;
    let new = app.make_task("Newer", None).await;
    for (id, since) in [(&old, "2026-01-01T00:00:00Z"), (&new, "2026-06-01T00:00:00Z")] {
        app.conn
            .execute(
                "UPDATE tasks SET waiting_since = ?1 WHERE id = ?2",
                rusqlite::params![since, id],
            )
            .unwrap();
    }
    assert_eq!(app.titles("/api/tasks/waiting").await, vec!["Older", "Newer"]);
}

#[tokio::test]
async fn completed_waiting_task_drops_off_the_waiting_list() {
    let app = test_app();
    let tid = app.make_task("Chase invoice", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/wait"), Some(json!({"waiting": true}))).await;
    app.request("POST", &format!("/api/tasks/{tid}/complete"), Some(json!({"completed": true})))
        .await;
    assert!(app.titles("/api/tasks/waiting").await.is_empty());
}

// ===== Maybe list (parked ideas, no date) =====

#[tokio::test]
async fn maybe_moves_task_off_board_into_maybe_list() {
    let app = test_app();
    let tid = app.make_task("Learn Esperanto", Some("2026-07-15")).await;

    let (status, task) = app
        .request("POST", &format!("/api/tasks/{tid}/maybe"), Some(json!({"maybe": true})))
        .await;

    assert_eq!(status, StatusCode::OK);
    assert!(task["maybe_since"].is_string());
    // Parking clears the board placement.
    assert!(task["due_date"].is_null());

    assert!(!app.titles("/api/tasks").await.contains(&"Learn Esperanto".to_string()));
    assert!(app.titles("/api/tasks/maybe").await.contains(&"Learn Esperanto".to_string()));
}

#[tokio::test]
async fn unmaybe_returns_task_to_the_board() {
    let app = test_app();
    let tid = app.make_task("Learn Esperanto", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/maybe"), Some(json!({"maybe": true}))).await;

    let (status, task) = app
        .request("POST", &format!("/api/tasks/{tid}/maybe"), Some(json!({"maybe": false})))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(task["maybe_since"].is_null());

    assert!(app.titles("/api/tasks").await.contains(&"Learn Esperanto".to_string()));
    assert!(app.titles("/api/tasks/maybe").await.is_empty());
}

#[tokio::test]
async fn maybe_is_exclusive_with_snooze_and_waiting() {
    let app = test_app();

    // Entering Maybe clears a snooze and a waiting state.
    let tid = app.make_task("Idea", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/snooze"), Some(json!({"until": "2099-01-01"})))
        .await;
    app.request("POST", &format!("/api/tasks/{tid}/wait"), Some(json!({"waiting": true}))).await;
    let (_, task) =
        app.request("POST", &format!("/api/tasks/{tid}/maybe"), Some(json!({"maybe": true}))).await;
    assert!(task["defer_until"].is_null());
    assert!(task["waiting_since"].is_null());

    // ... and snoozing or waiting takes the task off the Maybe list again.
    let (_, task) = app
        .request("POST", &format!("/api/tasks/{tid}/snooze"), Some(json!({"until": "2099-01-01"})))
        .await;
    assert!(task["maybe_since"].is_null());

    app.request("POST", &format!("/api/tasks/{tid}/maybe"), Some(json!({"maybe": true}))).await;
    let (_, task) =
        app.request("POST", &format!("/api/tasks/{tid}/wait"), Some(json!({"waiting": true}))).await;
    assert!(task["maybe_since"].is_null());
}

#[tokio::test]
async fn scheduling_a_maybe_task_promotes_it_to_the_board() {
    let app = test_app();
    let tid = app.make_task("Idea", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/maybe"), Some(json!({"maybe": true}))).await;

    let (status, task) = app
        .request(
            "PATCH",
            &format!("/api/tasks/{tid}"),
            Some(json!({"title": "Idea", "description": "", "due_date": "2026-07-20"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(task["maybe_since"].is_null());
    assert_eq!(task["due_date"], "2026-07-20");
    assert!(app.titles("/api/tasks/maybe").await.is_empty());
}

#[tokio::test]
async fn maybe_list_orders_by_position_with_since_breaking_ties() {
    let app = test_app();
    let tied_old = app.make_task("Tied old", None).await;
    let tied_new = app.make_task("Tied new", None).await;
    let later = app.make_task("Later", None).await;
    for (id, position, since) in [
        (&tied_old, 0, "2024-01-01T00:00:00Z"),
        (&tied_new, 0, "2025-01-01T00:00:00Z"),
        (&later, 1, "2023-01-01T00:00:00Z"),
    ] {
        app.conn
            .execute(
                "UPDATE tasks SET position = ?1, maybe_since = ?2 WHERE id = ?3",
                rusqlite::params![position, since, id],
            )
            .unwrap();
    }
    assert_eq!(app.titles("/api/tasks/maybe").await, vec!["Tied old", "Tied new", "Later"]);
}

#[tokio::test]
async fn reorder_persists_maybe_list_order() {
    let app = test_app();
    let a = app.make_task("A", None).await;
    let b = app.make_task("B", None).await;
    for id in [&a, &b] {
        app.request("POST", &format!("/api/tasks/{id}/maybe"), Some(json!({"maybe": true})))
            .await;
    }

    let (status, _) = app
        .request(
            "POST",
            "/api/tasks/reorder",
            Some(json!({"tasks": [
                {"id": b, "due_date": null, "position": 0},
                {"id": a, "due_date": null, "position": 1},
            ]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // New order persisted, and reordering did not pull the tasks off the list.
    assert_eq!(app.titles("/api/tasks/maybe").await, vec!["B", "A"]);
}

#[tokio::test]
async fn completed_maybe_task_drops_off_the_maybe_list() {
    let app = test_app();
    let tid = app.make_task("Idea", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/maybe"), Some(json!({"maybe": true}))).await;
    app.request("POST", &format!("/api/tasks/{tid}/complete"), Some(json!({"completed": true})))
        .await;
    assert!(app.titles("/api/tasks/maybe").await.is_empty());
}

// ===== /api/tasks/open — the Contexts tab's "everything open" feed =====

#[tokio::test]
async fn open_includes_board_backlog_snoozed_and_waiting() {
    let app = test_app();
    app.make_task("Scheduled", Some("2026-07-15")).await;
    app.make_task("Backlog", None).await;
    let snoozed = app.make_task("Snoozed", Some("2026-07-15")).await;
    let waiting = app.make_task("Waiting", Some("2026-07-15")).await;

    app.request("POST", &format!("/api/tasks/{snoozed}/snooze"), Some(json!({"until": "2099-01-01"})))
        .await;
    app.request("POST", &format!("/api/tasks/{waiting}/wait"), Some(json!({"waiting": true})))
        .await;

    let mut titles = app.titles("/api/tasks/open").await;
    titles.sort();
    assert_eq!(titles, vec!["Backlog", "Scheduled", "Snoozed", "Waiting"]);
}

#[tokio::test]
async fn open_excludes_completed_and_deleted() {
    let app = test_app();
    let done = app.make_task("Done", None).await;
    let gone = app.make_task("Gone", None).await;
    app.make_task("Alive", None).await;

    app.request("POST", &format!("/api/tasks/{done}/complete"), Some(json!({"completed": true})))
        .await;
    app.request("DELETE", &format!("/api/tasks/{gone}"), None).await;

    assert_eq!(app.titles("/api/tasks/open").await, vec!["Alive"]);
}

#[tokio::test]
async fn open_orders_by_due_date_with_backlog_last() {
    let app = test_app();
    app.make_task("Backlog", None).await;
    app.make_task("Later", Some("2026-08-01")).await;
    app.make_task("Sooner", Some("2026-07-01")).await;
    assert_eq!(app.titles("/api/tasks/open").await, vec!["Sooner", "Later", "Backlog"]);
}

// ===== Snooze / board interplay =====

#[tokio::test]
async fn snoozed_task_leaves_board_and_lists_under_snoozed() {
    let app = test_app();
    let tid = app.make_task("Nap", Some("2026-07-15")).await;
    let (status, task) = app
        .request("POST", &format!("/api/tasks/{tid}/snooze"), Some(json!({"until": "2099-01-01"})))
        .await;
    assert_eq!(status, StatusCode::OK);
    // Snoozing takes the task off the board entirely.
    assert!(task["due_date"].is_null());
    assert_eq!(task["defer_until"], "2099-01-01");

    assert!(app.titles("/api/tasks").await.is_empty());
    assert_eq!(app.titles("/api/tasks/snoozed").await, vec!["Nap"]);
}

#[tokio::test]
async fn unsnooze_returns_task_to_backlog() {
    let app = test_app();
    let tid = app.make_task("Nap", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/snooze"), Some(json!({"until": "2099-01-01"})))
        .await;
    let (status, task) = app
        .request("POST", &format!("/api/tasks/{tid}/snooze"), Some(json!({"until": null})))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(task["defer_until"].is_null());
    assert_eq!(app.titles("/api/tasks").await, vec!["Nap"]);
}

#[tokio::test]
async fn editing_a_due_date_clears_the_snooze() {
    let app = test_app();
    let tid = app.make_task("Nap", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/snooze"), Some(json!({"until": "2099-01-01"})))
        .await;
    let (status, task) = app
        .request(
            "PATCH",
            &format!("/api/tasks/{tid}"),
            Some(json!({"title": "Nap", "description": "", "due_date": "2026-07-20"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(task["due_date"], "2026-07-20");
    assert!(task["defer_until"].is_null(), "scheduling must clear the snooze");
}

#[tokio::test]
async fn reorder_onto_a_day_clears_the_snooze() {
    let app = test_app();
    let tid = app.make_task("Nap", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/snooze"), Some(json!({"until": "2099-01-01"})))
        .await;
    let (status, _) = app
        .request(
            "POST",
            "/api/tasks/reorder",
            Some(json!({"tasks": [{"id": tid, "due_date": "2026-07-20", "position": 1}]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(app.titles("/api/tasks").await, vec!["Nap"]);
}

// ===== Search: after/before completion-date bounds =====

#[tokio::test]
async fn after_is_inclusive_of_period_start() {
    let app = test_app();
    app.add_completed("jan", "2025-01-01T09:00:00Z");
    app.add_completed("dec", "2024-12-31T23:00:00Z");
    assert_eq!(search_titles(&app, "after=2025-01-01").await, vec!["jan"]);
}

#[tokio::test]
async fn before_excludes_the_named_day() {
    let app = test_app();
    app.add_completed("jun", "2024-06-30T10:00:00Z");
    app.add_completed("jul", "2024-07-01T00:00:01Z");
    assert_eq!(search_titles(&app, "before=2024-07-01").await, vec!["jun"]);
}

#[tokio::test]
async fn after_and_before_form_a_half_open_range() {
    let app = test_app();
    app.add_completed("dec24", "2024-12-31T12:00:00Z");
    app.add_completed("jan25", "2025-01-15T12:00:00Z");
    app.add_completed("mar25", "2025-03-31T23:59:59Z");
    app.add_completed("apr25", "2025-04-01T00:00:00Z");
    let mut titles = search_titles(&app, "after=2025-01-01&before=2025-04-01").await;
    titles.sort();
    assert_eq!(titles, vec!["jan25", "mar25"]);
}

#[tokio::test]
async fn date_bound_excludes_open_tasks() {
    let app = test_app();
    app.make_task("open task", None).await;
    app.add_completed("done task", "2025-06-01T08:00:00Z");
    assert_eq!(search_titles(&app, "after=2025-01-01").await, vec!["done task"]);
}

#[tokio::test]
async fn date_bound_combines_with_text() {
    let app = test_app();
    app.add_completed("deploy the invoice service", "2025-02-01T08:00:00Z");
    app.add_completed("deploy the auth service", "2025-02-01T08:00:00Z");
    assert_eq!(
        search_titles(&app, "q=invoice&after=2025-01-01").await,
        vec!["deploy the invoice service"]
    );
}

#[tokio::test]
async fn invalid_date_bound_is_ignored() {
    let app = test_app();
    app.add_completed("something", "2025-02-01T08:00:00Z");
    assert!(search_titles(&app, "after=not-a-date").await.is_empty());
}

#[tokio::test]
async fn empty_query_with_no_bounds_returns_nothing() {
    let app = test_app();
    app.add_completed("something", "2025-02-01T08:00:00Z");
    assert!(search_titles(&app, "q=").await.is_empty());
}

#[tokio::test]
async fn include_done_false_excludes_completed_tasks() {
    let app = test_app();
    app.add_completed("done deploy", "2025-02-01T08:00:00Z");
    app.make_task("open deploy", None).await;
    assert_eq!(search_titles(&app, "q=deploy&include_done=false").await, vec!["open deploy"]);
}

#[tokio::test]
async fn like_wildcards_are_matched_literally() {
    let app = test_app();
    app.make_task("has a 100% literal_underscore", None).await;
    app.make_task("nothing to see", None).await;
    assert_eq!(
        search_titles(&app, "q=100%25").await,
        vec!["has a 100% literal_underscore"]
    );
    assert!(search_titles(&app, "q=x_y").await.is_empty());
}

// ===== Per-task updates log =====

#[tokio::test]
async fn new_task_gets_task_created_system_entry() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    let ups = app.updates(&tid).await;
    assert_eq!(ups.len(), 1);
    assert_eq!(ups[0]["kind"], "system");
    assert_eq!(ups[0]["body"], "Task created");
}

#[tokio::test]
async fn post_user_update_trims_body() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    let (status, up) = app
        .request(
            "POST",
            &format!("/api/tasks/{tid}/updates"),
            Some(json!({"body": "  did a thing  "})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(up["body"], "did a thing");
    assert_eq!(up["kind"], "user");
}

#[tokio::test]
async fn updates_returned_newest_first() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/updates"), Some(json!({"body": "first"})))
        .await;
    app.request("POST", &format!("/api/tasks/{tid}/updates"), Some(json!({"body": "second"})))
        .await;
    let bodies: Vec<_> =
        app.updates(&tid).await.iter().map(|u| u["body"].as_str().unwrap().to_string()).collect();
    assert_eq!(bodies, vec!["second", "first", "Task created"]);
}

#[tokio::test]
async fn post_empty_body_rejected() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    let (status, _) = app
        .request("POST", &format!("/api/tasks/{tid}/updates"), Some(json!({"body": "   "})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn post_to_missing_task_404() {
    let app = test_app();
    let (status, _) =
        app.request("POST", "/api/tasks/nope/updates", Some(json!({"body": "x"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn edit_preserves_original_timestamp() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    let (_, created) = app
        .request("POST", &format!("/api/tasks/{tid}/updates"), Some(json!({"body": "before"})))
        .await;
    let (status, edited) = app
        .request(
            "PUT",
            &format!("/api/updates/{}", created["id"].as_str().unwrap()),
            Some(json!({"body": "after"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["body"], "after");
    assert_eq!(edited["created_at"], created["created_at"]);
}

#[tokio::test]
async fn edit_system_entry_forbidden() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    let sid = app.system_update_id(&tid).await;
    let (status, _) =
        app.request("PUT", &format!("/api/updates/{sid}"), Some(json!({"body": "hack"}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn edit_missing_update_404() {
    let app = test_app();
    let (status, _) = app.request("PUT", "/api/updates/nope", Some(json!({"body": "x"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_user_update() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    let (_, up) = app
        .request("POST", &format!("/api/tasks/{tid}/updates"), Some(json!({"body": "temp"})))
        .await;
    let (status, _) = app
        .request("DELETE", &format!("/api/updates/{}", up["id"].as_str().unwrap()), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let bodies: Vec<_> =
        app.updates(&tid).await.iter().map(|u| u["body"].as_str().unwrap().to_string()).collect();
    assert_eq!(bodies, vec!["Task created"]);
}

#[tokio::test]
async fn delete_system_entry_forbidden() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    let sid = app.system_update_id(&tid).await;
    let (status, _) = app.request("DELETE", &format!("/api/updates/{sid}"), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn delete_missing_update_404() {
    let app = test_app();
    let (status, _) = app.request("DELETE", "/api/updates/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn permanent_task_delete_removes_updates() {
    let app = test_app();
    let tid = app.make_task("Task", None).await;
    app.request("POST", &format!("/api/tasks/{tid}/updates"), Some(json!({"body": "note"})))
        .await;
    app.request("DELETE", &format!("/api/tasks/{tid}/permanent"), None).await;
    assert!(app.updates(&tid).await.is_empty());
}

// ===== Search over update bodies =====

#[tokio::test]
async fn search_matches_update_body() {
    let app = test_app();
    app.make_task("Vendor task", None).await;
    let tid = app.make_task("Vendor task", None).await;
    app.request(
        "POST",
        &format!("/api/tasks/{tid}/updates"),
        Some(json!({"body": "talked to giraffe"})),
    )
    .await;
    assert_eq!(search_titles(&app, "q=giraffe").await, vec!["Vendor task"]);
}

#[tokio::test]
async fn search_words_and_across_fields() {
    let app = test_app();
    let tid = app.make_task("T", None).await;
    app.conn
        .execute("UPDATE tasks SET description = 'has zebra' WHERE id = ?1", [&tid])
        .unwrap();
    app.request(
        "POST",
        &format!("/api/tasks/{tid}/updates"),
        Some(json!({"body": "and a giraffe"})),
    )
    .await;
    assert_eq!(search_titles(&app, "q=zebra%20giraffe").await, vec!["T"]);
    assert!(search_titles(&app, "q=zebra%20platypus").await.is_empty());
}

#[tokio::test]
async fn search_excludes_system_entries() {
    let app = test_app();
    app.make_task("Plain", None).await;
    // "created" only appears in the system "Task created" entry -> no match.
    assert!(search_titles(&app, "q=created").await.is_empty());
}

#[tokio::test]
async fn search_no_duplicate_rows() {
    let app = test_app();
    let tid = app.make_task("uniqueword", None).await;
    app.conn
        .execute("UPDATE tasks SET description = 'uniqueword here' WHERE id = ?1", [&tid])
        .unwrap();
    for body in ["uniqueword one", "uniqueword two"] {
        app.request("POST", &format!("/api/tasks/{tid}/updates"), Some(json!({"body": body})))
            .await;
    }
    assert_eq!(search_titles(&app, "q=uniqueword").await, vec!["uniqueword"]);
}

#[tokio::test]
async fn search_case_insensitive_ascii() {
    let app = test_app();
    let tid = app.make_task("T", None).await;
    app.request(
        "POST",
        &format!("/api/tasks/{tid}/updates"),
        Some(json!({"body": "ALLCAPS word"})),
    )
    .await;
    assert_eq!(search_titles(&app, "q=allcaps").await, vec!["T"]);
}

// ===== Lifecycle: complete / trash / restore =====

#[tokio::test]
async fn complete_stamps_and_reopen_clears_completed_at() {
    let app = test_app();
    let tid = app.make_task("Ship it", None).await;
    let (_, done) = app
        .request("POST", &format!("/api/tasks/{tid}/complete"), Some(json!({"completed": true})))
        .await;
    assert_eq!(done["completed"], true);
    let stamp = done["completed_at"].as_str().unwrap();
    assert!(stamp.ends_with('Z') && stamp.contains('T'), "RFC 3339, got {stamp}");

    let (_, reopened) = app
        .request("POST", &format!("/api/tasks/{tid}/complete"), Some(json!({"completed": false})))
        .await;
    assert_eq!(reopened["completed"], false);
    assert!(reopened["completed_at"].is_null());
}

#[tokio::test]
async fn soft_delete_moves_to_trash_and_restore_brings_back() {
    let app = test_app();
    let tid = app.make_task("Oops", None).await;
    let (status, _) = app.request("DELETE", &format!("/api/tasks/{tid}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(app.titles("/api/tasks").await.is_empty());
    assert_eq!(app.titles("/api/tasks/deleted").await, vec!["Oops"]);

    let (status, task) =
        app.request("POST", &format!("/api/tasks/{tid}/restore"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(task["deleted_at"].is_null());
    assert_eq!(app.titles("/api/tasks").await, vec!["Oops"]);
}

#[tokio::test]
async fn archive_paginates_with_has_more() {
    let app = test_app();
    for i in 0..3 {
        app.add_completed(&format!("done{i}"), &format!("2025-06-0{}T08:00:00Z", i + 1));
    }
    let (status, page) = app.get("/api/tasks/archive?limit=2&offset=0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(page["has_more"], true);
    // Newest completion first.
    assert_eq!(page["tasks"][0]["title"], "done2");

    let (_, page2) = app.get("/api/tasks/archive?limit=2&offset=2").await;
    assert_eq!(page2["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(page2["has_more"], false);
}

#[tokio::test]
async fn unknown_task_actions_return_404() {
    let app = test_app();
    for (method, path, body) in [
        ("POST", "/api/tasks/nope/complete", Some(json!({"completed": true}))),
        ("POST", "/api/tasks/nope/snooze", Some(json!({"until": null}))),
        ("POST", "/api/tasks/nope/wait", Some(json!({"waiting": true}))),
        ("POST", "/api/tasks/nope/maybe", Some(json!({"maybe": true}))),
        ("POST", "/api/tasks/nope/restore", None),
        ("PATCH", "/api/tasks/nope", Some(json!({"title": "x", "description": "", "due_date": null}))),
        ("DELETE", "/api/tasks/nope", None),
        ("DELETE", "/api/tasks/nope/permanent", None),
    ] {
        let (status, _) = app.request(method, path, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    }
}

// ===== Settings =====

#[tokio::test]
async fn contexts_roundtrip_and_merge_over_defaults() {
    let app = test_app();
    let (_, defaults) = app.get("/api/settings/contexts").await;
    assert_eq!(defaults["red"], "urgent");

    let new = json!({"red": "asap", "green": "review", "blue": "work",
                     "yellow": "someday", "purple": "home"});
    let (status, saved) = app.request("PUT", "/api/settings/contexts", Some(new.clone())).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved, new);

    // A partial stored value merges over the defaults.
    app.conn
        .execute(
            "UPDATE settings SET value = '{\"red\": \"fire\"}' WHERE key = 'contexts'",
            [],
        )
        .unwrap();
    let (_, merged) = app.get("/api/settings/contexts").await;
    assert_eq!(merged["red"], "fire");
    assert_eq!(merged["blue"], "work", "missing keys fall back to defaults");
}
