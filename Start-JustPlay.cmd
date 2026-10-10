@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js and npm were not found. Install Node.js LTS from https://nodejs.org/ and reopen Command Prompt.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing JustPlay dependencies for the first run...
  call npm install
  if errorlevel 1 (pause & exit /b 1)
)
call npm run dev
if errorlevel 1 pause
