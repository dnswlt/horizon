@echo off
REM Build a single self-contained Horizon.exe for Windows.
REM Run this once on a Windows machine with Python installed; hand dist\Horizon.exe
REM to the user. They double-click it; the app opens in their browser.

python -m pip install -r requirements.txt pyinstaller || goto :error

REM Invoke via `python -m` so it works even when the Scripts dir isn't on PATH.
python -m PyInstaller --onefile --name Horizon --add-data "static;static" run.py || goto :error

echo.
echo Done. Your app is at: dist\Horizon.exe
goto :eof

:error
echo.
echo Build failed. See the output above.
exit /b 1
