@echo off
REM Build a single self-contained Horizon.exe for Windows.
REM Run this once on a Windows machine with Python installed; hand dist\Horizon.exe
REM to the user. They double-click it; the app opens in its own window.

REM pywebview is only needed for the packaged app (native window via Edge
REM WebView2), so it lives here rather than in requirements.txt.
python -m pip install -r requirements.txt pyinstaller pywebview || goto :error

REM --windowed suppresses the console window so it's a clean GUI app.
REM Invoke via `python -m` so it works even when the Scripts dir isn't on PATH.
python -m PyInstaller --onefile --windowed --name Horizon --icon "static\favicon.ico" --add-data "static;static" run.py || goto :error

echo.
echo Done. Your app is at: dist\Horizon.exe
goto :eof

:error
echo.
echo Build failed. See the output above.
exit /b 1
