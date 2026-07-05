"""Packaged entrypoint for the double-click Windows build.

Only used by the PyInstaller .exe. Development still runs the server the
usual way (`uvicorn server:app --reload`); this file is not imported there.
"""
import threading
import webbrowser

import uvicorn

from server import app

URL = "http://127.0.0.1:8000"

if __name__ == "__main__":
    # Give uvicorn a moment to bind, then open the browser for the user.
    threading.Timer(1.5, lambda: webbrowser.open(URL)).start()
    uvicorn.run(app, host="127.0.0.1", port=8000)
