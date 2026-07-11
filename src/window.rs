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
        .build(&event_loop)
        .expect("failed to create the app window");

    apply_dark_titlebar(&window);

    let webview = WebViewBuilder::new()
        .with_url(&url)
        .with_initialization_script(RELOAD_JS)
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
