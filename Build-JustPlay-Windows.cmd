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
  echo Installing build dependencies. This can take several minutes on the first run...
  call npm install
  if errorlevel 1 (pause & exit /b 1)
)
call npm run check
if errorlevel 1 (pause & exit /b 1)
call npm run dist:win
if errorlevel 1 (pause & exit /b 1)
echo.
echo Build complete. Find the installer in the dist folder.
pause
