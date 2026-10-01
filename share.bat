@echo off
REM NIEC Visa AI - put this computer's site online with a temporary public link.
REM Keep this window open while people use the link.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node 22.5 or newer from https://nodejs.org
  pause
  exit /b 1
)

node scripts/share.mjs
pause
