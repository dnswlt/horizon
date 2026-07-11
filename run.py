"""Packaged entrypoint for the double-click Windows build.

Runs the uvicorn server in a background thread and shows the app in a
dedicated native window (Edge WebView2 via pywebview) instead of a browser
tab, so it gets its own taskbar icon and window chrome.

Only used by the PyInstaller .exe. Development still runs the server the
usual way (`uvicorn server:app --reload`); this file is not imported there.
"""
import logging
import os
import socket
import sys
import threading
import time

import uvicorn
import webview

from server import app

HOST = "127.0.0.1"
PORT = 8063
URL = f"http://{HOST}:{PORT}"

# DWM (Desktop Window Manager) window attributes, used to darken the native
# window's title bar to match the app's dark theme.
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_CAPTION_COLOR = 35

# WebView2 doesn't wire up the browser's Ctrl-R / F5 reload shortcuts, so there
# is no built-in way to refresh the page in the packaged app. Inject our own
# keydown listener that calls location.reload(). This lives only in the
# WebView2 entrypoint, so the browser dev build never captures these keys.
RELOAD_JS = """
document.addEventListener('keydown', function (e) {
    var isReload = e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R') &&
         !e.shiftKey && !e.altKey);
    if (isReload) {
        e.preventDefault();
        window.location.reload();
    }
});
"""


def _base_dir():
    """Directory to write runtime files into: next to the .exe when frozen,
    next to this script in development."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


# The packaged app is --windowed, so there's no console and (worse) sys.stderr
# is None, which breaks the usual stream logging. Send everything to a file
# next to the exe instead, so a crash is debuggable when a user reports "it
# won't open." log_config=None stops uvicorn from installing its own
# stderr-based handlers; its loggers then propagate to this root handler.
logging.basicConfig(
    filename=os.path.join(_base_dir(), "horizon.log"),
    level=logging.WARNING,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


def serve():
    # Catch SystemExit too: uvicorn raises it on a bind failure, and letting it
    # escape a daemon thread hits the threading excepthook, which writes to
    # sys.stderr — None in the windowed build, so it would fail again there.
    try:
        uvicorn.run(app, host=HOST, port=PORT, log_level="warning", log_config=None)
    except (Exception, SystemExit):
        logging.exception("uvicorn server crashed")


def apply_dark_titlebar():
    """Make the native window's title bar dark to match the app's dark theme.

    Windows draws the title bar itself, so CSS can't touch it. We use the DWM
    (Desktop Window Manager) API: DWMWA_USE_IMMERSIVE_DARK_MODE gives the
    standard dark caption, and DWMWA_CAPTION_COLOR paints it the exact app
    background (--bg-app, #080c14). Requires Windows 11. Runs via
    webview.start(func); the window may not be titled yet, so we retry."""
    if sys.platform != "win32":
        return
    import ctypes

    hwnd = 0
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        hwnd = ctypes.windll.user32.FindWindowW(None, "Horizon")
        if hwnd:
            break
        time.sleep(0.1)
    if not hwnd:
        return

    dwm = ctypes.windll.dwmapi
    enabled = ctypes.c_int(1)
    dwm.DwmSetWindowAttribute(
        hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ctypes.byref(enabled), ctypes.sizeof(enabled))
    # DWMWA_CAPTION_COLOR wants a COLORREF (0x00BBGGRR). #080c14 ->
    # R=0x08 G=0x0c B=0x14.
    caption = ctypes.c_int(0x00140C08)
    dwm.DwmSetWindowAttribute(
        hwnd, DWMWA_CAPTION_COLOR, ctypes.byref(caption), ctypes.sizeof(caption))


def wait_until_ready(timeout=15.0):
    """Block until the server accepts connections, so the window never opens
    on a not-yet-bound port and shows a connection error."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((HOST, PORT), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


if __name__ == "__main__":
    try:
        # Daemon thread: when the window closes, the main thread returns and
        # the process exits, taking the server thread down with it.
        threading.Thread(target=serve, daemon=True).start()
        wait_until_ready()
        window = webview.create_window("Horizon", URL, width=1200, height=800)
        # Re-inject on every page load: a reload replaces the document and drops
        # the previous listener, so the handler must be re-added each time.
        window.events.loaded += lambda *args: window.evaluate_js(RELOAD_JS)
        # func runs in a worker thread once the GUI loop is up, so it can find
        # and restyle the now-created native window without blocking it.
        webview.start(apply_dark_titlebar)
    except Exception:
        logging.exception("Horizon failed to start")
        raise
