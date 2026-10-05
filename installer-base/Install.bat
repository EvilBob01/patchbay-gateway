@echo off
REM Double-click entry point. Runs the PowerShell installer with execution policy
REM bypassed for just this one process (no permanent system change).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
