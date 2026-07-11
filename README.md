# Horizon

A lightweight, single-user task planner. Upcoming tasks live on the
**horizon** — five lanes for the next five workdays — plus a backlog for
everything undated.

## Windows: double-click app

Grab `Horizon-<version>.exe` from the
[Releases page](https://github.com/dnswlt/horizon/releases) — one
self-contained file, nothing else to install. Put it in its own folder
(your tasks are stored in a `tasks.db` SQLite file created next to the exe)
and run it. The app opens in its own window with its own taskbar icon (a
native window via Edge WebView2, which ships with Windows 10/11).

Notes:

- First launch may show a SmartScreen warning (unsigned app) → **More info →
  Run anyway**.
- Updating is replacing the exe; `tasks.db` stays where it is. Databases
  created by older (Python-based) versions are upgraded automatically on
  first launch.

## Browser mode

The same binary is an ordinary local web server:

```bash
Horizon.exe --serve          # then open http://127.0.0.1:8063
Horizon.exe --serve --port 9000
```

## Development

You need [Rust](https://rustup.rs/) (stable, MSVC toolchain on Windows).

```bash
cargo run -- --serve   # dev server; frontend edits are picked up on reload
cargo run              # dev build of the windowed app
make test              # backend (cargo test) + frontend (npm test)
```

Debug builds serve `static/` from disk and keep `tasks.db` in the repo root;
release builds embed the frontend into the exe and keep data next to the exe.

### Releasing

Releases are built automatically by
[.github/workflows/release.yml](.github/workflows/release.yml) whenever a
`v*.*.*` tag is pushed. A local release build is just:

```bash
cargo build --release   # -> target/release/Horizon.exe
```
