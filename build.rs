fn main() {
    // Embed the exe icon and version info (taken from Cargo.toml) as Windows
    // resources — this is what the taskbar and Explorer show.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("static/favicon.ico");
        res.compile().expect("failed to embed Windows resources");
    }
    println!("cargo:rerun-if-changed=static/favicon.ico");
}
