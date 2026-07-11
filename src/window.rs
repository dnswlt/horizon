//! The native window shell: a WebView2 (Edge) window pointed at the local
//! server, so the app gets its own taskbar icon and window chrome instead of
//! living in a browser tab.

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::{Window, WindowBuilder};
use wry::WebViewBuilder;

/// WebView2 doesn't wire up the browser's Ctrl-R / F5 reload shortcuts, so
/// there is no built-in way to refresh the page in the packaged app. Inject
/// our own keydown listener that calls location.reload(). Initialization
/// scripts run on every navigation, so a reload re-installs the listener
/// automatically. This lives only in the window shell — the browser mode
/// never captures these keys.
const RELOAD_JS: &str = "
document.addEventListener('keydown', function (e) {
    var isReload = e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R') &&
         !e.shiftKey && !e.altKey);
    if (isReload) {
        e.preventDefault();
        window.location.reload();
    }
});
";

/// Open the app window and run the GUI event loop; never returns. The
/// process exits when the window is closed, taking the server thread down
/// with it.
pub fn run(url: String) -> ! {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Horizon")
        .with_inner_size(LogicalSize::new(1200.0, 800.0))
        .with_window_icon(app_icon())
        .build(&event_loop)
        .expect("failed to create the app window");

    apply_dark_titlebar(&window);

    let origin = url.clone();
    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(RELOAD_JS)
        // target=_blank links (e.g. the description's link chips) ask for a
        // new window; there is no second webview window, so hand them to the
        // default browser instead — matching what browser mode does.
        .with_new_window_req_handler(|new_url, _features| {
            open_in_browser(&new_url);
            wry::NewWindowResponse::Deny
        })
        // Keep the webview itself on the local app origin; any other
        // navigation goes to the browser too, so the app UI can never be
        // navigated away.
        .with_navigation_handler(move |target| {
            if target == origin || target.starts_with(&format!("{origin}/")) {
                true
            } else {
                open_in_browser(&target);
                false
            }
        })
        .build(&window)
        .expect("failed to create the WebView2 webview (is the WebView2 runtime installed?)");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        // The webview must live as long as the event loop; the closure owns it.
        let _ = &webview;
        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
        }
    })
}

/// Make the native window's title bar dark to match the app's dark theme.
///
/// Windows draws the title bar itself, so CSS can't touch it. We use the DWM
/// (Desktop Window Manager) API: DWMWA_USE_IMMERSIVE_DARK_MODE gives the
/// standard dark caption, and DWMWA_CAPTION_COLOR paints it the exact app
/// background (--bg-app, #080c14). Requires Windows 11; harmless no-op below.
#[cfg(windows)]
fn apply_dark_titlebar(window: &Window) {
    use tao::platform::windows::WindowExtWindows;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DWMWA_CAPTION_COLOR, DWMWA_USE_IMMERSIVE_DARK_MODE, DwmSetWindowAttribute,
    };

    let hwnd = HWND(window.hwnd() as _);
    let dark: i32 = 1;
    // COLORREF is 0x00BBGGRR: #080c14 -> R=0x08 G=0x0c B=0x14.
    let caption: u32 = 0x0014_0C08;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            (&raw const dark).cast(),
            size_of_val(&dark) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR,
            (&raw const caption).cast(),
            size_of_val(&caption) as u32,
        );
    }
}

#[cfg(not(windows))]
fn apply_dark_titlebar(_window: &Window) {}

/// Open a link in the user's default browser. Only http(s) is allowed:
/// content in the webview is user-authored, but ShellExecute on an arbitrary
/// scheme could launch arbitrary protocol handlers, so everything else is
/// dropped. (The frontend already restricts link chips to http(s) — this is
/// the same boundary enforced on the shell side.)
fn open_in_browser(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        log::warn!("blocked external navigation to non-http URL: {url}");
        return;
    }
    open_in_browser_impl(url);
}

#[cfg(windows)]
fn open_in_browser_impl(url: &str) {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{HSTRING, w};

    // Per the ShellExecute contract, a return value <= 32 is an error.
    let result = unsafe {
        ShellExecuteW(None, w!("open"), &HSTRING::from(url), None, None, SW_SHOWNORMAL)
    };
    if result.0 as isize <= 32 {
        log::warn!("failed to open {url} in the default browser");
    }
}

#[cfg(target_os = "macos")]
fn open_in_browser_impl(url: &str) {
    if let Err(e) = std::process::Command::new("open").arg(url).spawn() {
        log::warn!("failed to open {url} in the default browser: {e}");
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_in_browser_impl(url: &str) {
    if let Err(e) = std::process::Command::new("xdg-open").arg(url).spawn() {
        log::warn!("failed to open {url} in the default browser: {e}");
    }
}

/// The window's title-bar icon. The exe icon embedded by build.rs only
/// covers Explorer and the taskbar; the window itself must be given an icon
/// explicitly, so load it back out of the exe's resources (winresource
/// stores the icon under resource ID 1).
#[cfg(windows)]
fn app_icon() -> Option<tao::window::Icon> {
    use tao::platform::windows::IconExtWindows;
    tao::window::Icon::from_resource(1, None).ok()
}

#[cfg(not(windows))]
fn app_icon() -> Option<tao::window::Icon> {
    None
}
