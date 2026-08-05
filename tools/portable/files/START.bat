@echo off
title HelaEngine
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo.
  echo   Get the LTS installer from https://nodejs.org, run it,
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)
start "" http://localhost:5174
node "%~dp0serve.js"
pause
