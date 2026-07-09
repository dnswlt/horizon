"""Packaged entrypoint for the double-click Windows build.

Runs the uvicorn server in a background thread and shows the app in a
dedicated native window (Edge WebView2 via pywebview) instead of a browser
tab, so it gets its own taskbar icon and window chrome.

Only used by the PyInstaller .exe. Development still runs the server the
usual way (`uvicorn server:app --reload`); this file is not imported there.
"""
import socket
import threading
import time

import uvicorn
import webview

from server import app

HOST = "127.0.0.1"
PORT = 8063
URL = f"http://{HOST}:{PORT}"


def serve():
    # log_level="warning" keeps the (hidden) console quiet in the packaged app.
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


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
    # Daemon thread: when the window closes, the main thread returns and the
    # process exits, taking the server thread down with it.
    threading.Thread(target=serve, daemon=True).start()
    wait_until_ready()
    webview.create_window("Horizon", URL, width=1200, height=800)
    webview.start()
