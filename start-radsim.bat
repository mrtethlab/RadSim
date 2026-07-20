@echo off
REM ============================================================================
REM  RadSim dev environment launcher
REM  Double-click this file (or run it) to start:
REM    1) the Python GPU compute backend  (http://127.0.0.1:8000)  - optional
REM    2) the Vite frontend dev server     (http://localhost:5173)
REM  Each server opens in its own window; close the window (or Ctrl+C in it) to
REM  stop that server. The backend is only needed for the Python GPU engine and
REM  backend-only models (e.g. the 0.25 mm shoulder) - the browser engine works
REM  without it.
REM ============================================================================

setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

REM --- make sure Node / npm is reachable (installer default dir) ---
where npm >nul 2>nul
if errorlevel 1 set "PATH=C:\Program Files\nodejs;%PATH%"

where npm >nul 2>nul
if errorlevel 1 (
  echo [error] npm not found. Install Node.js, or edit the PATH line in this script.
  echo         Expected at: C:\Program Files\nodejs\
  pause
  exit /b 1
)

REM --- backend (needs the Python venv in services\compute\.venv) ---
set "VENV=%ROOT%services\compute\.venv\Scripts\python.exe"
if exist "%VENV%" (
  echo Starting Python GPU backend  ^-^>  http://127.0.0.1:8000
  start "RadSim Backend (uvicorn :8000)" /d "%ROOT%services\compute" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
) else (
  echo [skip] Backend venv not found at services\compute\.venv
  echo        The browser engine still works; see services\compute\requirements.txt to enable the GPU backend.
)

REM --- frontend (Vite; inherits this window's directory = repo root) ---
echo Starting Vite frontend       ^-^>  http://localhost:5173
start "RadSim Frontend (Vite)" cmd /k "npm run dev"

REM --- open the app once Vite has had a moment to boot ---
echo Waiting for the dev server to come up...
timeout /t 4 /nobreak >nul
start "" http://localhost:5173/

echo.
echo ============================================================================
echo  Two windows opened: "RadSim Backend" and "RadSim Frontend".
echo  If the browser shows nothing, check the Frontend window for the real port
echo  (Vite uses 5174/5175 if 5173 is busy) and open that URL.
echo  Close both windows to shut everything down.
echo ============================================================================
endlocal
