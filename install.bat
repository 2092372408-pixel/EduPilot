@echo off
title EduPilot Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed. Press any key to close this window.
  pause >nul
  exit /b 1
)
exit /b 0
