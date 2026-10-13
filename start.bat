@echo off
title EduPilot
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. Press any key to close this window.
  pause >nul
  exit /b 1
)
exit /b 0
