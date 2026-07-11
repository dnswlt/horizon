//! Where runtime files live.
//!
//! Release builds are portable: the database and log file sit next to the
//! exe, exactly like the PyInstaller build did, so an existing install keeps
//! its data when the exe is swapped. Debug builds use the repo root so
//! `cargo run` behaves like the old dev workflow.

use std::path::PathBuf;

pub fn base_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

pub fn db_file() -> PathBuf {
    base_dir().join("tasks.db")
}

pub fn log_file() -> PathBuf {
    base_dir().join("horizon.log")
}

/// The on-disk static/ folder, used instead of the embedded assets in debug
/// builds (so frontend edits don't require a rebuild) or when --static-dir
/// is given.
pub fn dev_static_dir() -> PathBuf {
    base_dir().join("static")
}
