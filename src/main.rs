//! Horizon — a lightweight personal task planner.
//!
//! Two run modes from the same binary:
//! - default: local server + native WebView2 window (the pinned taskbar app)
//! - `--serve`: headless server only; open http://127.0.0.1:8063 in a browser

// Release builds must not flash a console window when launched from the
// taskbar; debug builds keep the console for logs and panics.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use horizon::{api, paths, window};
use log::LevelFilter;
use simplelog::{ColorChoice, Config, TermLogger, TerminalMode, WriteLogger};

const DEFAULT_PORT: u16 = 8063;

struct Args {
    serve: bool,
    port: u16,
}

fn parse_args() -> Args {
    let mut args = Args { serve: false, port: DEFAULT_PORT };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--serve" => args.serve = true,
            "--port" => {
                args.port = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| fail("--port requires a port number"));
            }
            "--help" | "-h" => {
                println!(
                    "Usage: horizon [--serve] [--port N]\n\n\
                     Without flags, opens the app in its own window.\n\
                     --serve   run the HTTP server only (use your browser)\n\
                     --port N  listen on port N (default {DEFAULT_PORT})"
                );
                std::process::exit(0);
            }
            other => fail(&format!("unknown argument: {other}")),
        }
    }
    args
}

fn fail(msg: &str) -> ! {
    // In the windowed release build stderr goes nowhere, so log too.
    log::error!("{msg}");
    eprintln!("horizon: {msg}");
    std::process::exit(2);
}

/// Debug builds log to the terminal; the windowed release build has no
/// stderr, so everything goes to horizon.log next to the exe instead — that
/// file is the only lead when a user reports "it won't open".
fn init_logging() {
    if cfg!(debug_assertions) {
        let _ = TermLogger::init(
            LevelFilter::Info,
            Config::default(),
            TerminalMode::Stderr,
            ColorChoice::Auto,
        );
    } else {
        let file = OpenOptions::new().create(true).append(true).open(paths::log_file());
        if let Ok(file) = file {
            let _ = WriteLogger::init(LevelFilter::Info, Config::default(), file);
        }
    }
}

/// Block until the server accepts connections, so the window never opens on
/// a not-yet-bound port and shows a connection error.
fn wait_until_ready(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn main() {
    init_logging();
    // The windowed release build swallows stderr, so panics (from the GUI
    // shell especially) must land in the log to be diagnosable.
    std::panic::set_hook(Box::new(|info| {
        log::error!("panic: {info}");
        eprintln!("{info}");
    }));
    let args = parse_args();
    let db_file = paths::db_file();

    if args.serve {
        println!("Horizon serving on http://127.0.0.1:{}", args.port);
        if let Err(e) = api::run_blocking(&db_file, args.port) {
            fail(&format!("server failed: {e}"));
        }
        return;
    }

    // Window mode: server on a background daemon thread; when the window
    // closes, main returns and the process exits, taking the server with it.
    let port = args.port;
    std::thread::spawn(move || {
        if let Err(e) = api::run_blocking(&db_file, port) {
            // Don't kill the window: if another Horizon instance already owns
            // the port, this window still connects to it and works.
            log::error!("server thread failed: {e}");
        }
    });
    if !wait_until_ready(port, Duration::from_secs(15)) {
        fail(&format!("server did not become ready on port {port}"));
    }
    window::run(format!("http://127.0.0.1:{port}"));
}
