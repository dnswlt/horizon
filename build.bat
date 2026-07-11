@echo off
REM Build a self-contained Horizon app folder for Windows.
REM Run this once on a Windows machine with Python installed; hand the whole
REM dist\Horizon folder to the user (e.g. zipped). They run Horizon.exe from
REM inside it; the app opens in its own window.

REM pywebview is only needed for the packaged app (native window via Edge
REM WebView2), so it lives here rather than in requirements.txt.
python -m pip install -r requirements.txt pyinstaller pywebview || goto :error

REM --windowed suppresses the console window so it's a clean GUI app.
REM Onedir (the default, no --onefile) avoids the self-extracting-to-temp
REM behavior that trips antivirus/SmartScreen heuristics on onefile builds.
REM Invoke via `python -m` so it works even when the Scripts dir isn't on PATH.
REM Keep this command in sync with the build step in
REM .github/workflows/release.yml, which runs the same build on tagged pushes.
python -m PyInstaller --noconfirm --windowed --name Horizon --icon "static\favicon.ico" --add-data "static;static" run.py || goto :error

echo.
echo Done. Your app is at: dist\Horizon\Horizon.exe
goto :eof

:error
echo.
echo Build failed. See the output above.
exit /b 1
