//! Frontend asset serving.
//!
//! Release builds embed everything under `static/` into the exe (that is
//! what makes the single-file distribution work). Debug builds read the
//! files from disk on every request — rust-embed's built-in behavior — so
//! frontend edits during development don't require a rebuild.

use axum::extract::Path;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "static/"]
struct Assets;

/// GET / — the app shell. Served with no-cache so a new build's index.html
/// (and its `?v=N` cache-busted asset URLs) is always picked up.
pub async fn index() -> Response {
    match serve("index.html") {
        Ok(mut resp) => {
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-cache, no-store, must-revalidate"),
            );
            resp
        }
        Err(status) => status.into_response(),
    }
}

/// GET /static/{*path}
pub async fn asset(Path(path): Path<String>) -> Response {
    serve(&path).unwrap_or_else(|status| status.into_response())
}

fn serve(path: &str) -> Result<Response, StatusCode> {
    let file = Assets::get(path).ok_or(StatusCode::NOT_FOUND)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Ok(([(header::CONTENT_TYPE, mime.as_ref())], file.data.into_owned()).into_response())
}
