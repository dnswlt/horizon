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
        webview.create_window("Horizon", URL, width=1200, height=800)
        webview.start()
    except Exception:
        logging.exception("Horizon failed to start")
        raise
