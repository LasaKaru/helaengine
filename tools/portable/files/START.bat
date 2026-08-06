@echo off
title HelaEngine
cd /d "%~dp0"

rem The bundled Node is preferred over anything installed, so the version this was tested against is
rem the version that runs. A machine with an old Node on PATH is otherwise a support ticket that
rem looks like a HelaEngine bug.
set "NODE_EXE=%~dp0runtime\node.exe"

if not exist "%NODE_EXE%" (
  rem No bundled runtime in this download. Fall back to an installed Node.
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   This copy has no bundled runtime and Node.js is not installed.
    echo.
    echo   Either download the bundle that includes a runtime, or get the
    echo   LTS installer from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

echo.
echo   Starting HelaEngine...
echo   Your browser will open at http://localhost:5174
echo.
echo   Leave this window open while you work. Close it to stop.
echo.

start "" http://localhost:5174
"%NODE_EXE%" "%~dp0serve.js"
pause
