@echo off
REM ============================================================================
REM  RadSim dev environment shutdown
REM  Stops the Vite frontend and the Python GPU compute backend started by
REM  start-radsim.bat. Only targets RadSim's own processes:
REM    - uvicorn (the compute backend on :8000)
REM    - the Vite dev server listening on 5173/5174/5175
REM  Other Node/Python apps are left alone.
REM ============================================================================

echo Stopping RadSim compute backend (uvicorn) ...
for /f "tokens=2 delims=," %%P in ('tasklist /fi "imagename eq python.exe" /fo csv /nh 2^>nul') do (
  wmic process where "ProcessId=%%~P" get CommandLine 2>nul | find /i "uvicorn" >nul && (
    echo   killing PID %%~P
    taskkill /PID %%~P /F >nul 2>nul
  )
)

echo Stopping RadSim frontend (Vite dev server) ...
for %%N in (5173 5174 5175) do (
  for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%%N .*LISTENING"') do (
    echo   port %%N -> killing PID %%P
    taskkill /PID %%P /F >nul 2>nul
  )
)

echo Done.
