fn main() {
    // Embed the short git commit hash so the running app can report exactly
    // which build it is (shown in the hamburger menu, next to the version).
    let hash = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=HORIZON_GIT_HASH={hash}");
    // .git/HEAD changes on checkout/commit, so the hash stays current.
    println!("cargo:rerun-if-changed=.git/HEAD");

    // Embed the exe icon and version info (taken from Cargo.toml) as Windows
    // resources — this is what the taskbar and Explorer show.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("static/favicon.ico");
        res.compile().expect("failed to embed Windows resources");
    }
    println!("cargo:rerun-if-changed=static/favicon.ico");
}
