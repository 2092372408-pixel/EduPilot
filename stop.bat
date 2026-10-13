@echo off
title EduPilot - Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
pause
