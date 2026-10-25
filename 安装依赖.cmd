@echo off
cd /d "%~dp0"
echo DSH-Chat requires Node.js 24.13 or newer.
call npm ci --ignore-scripts
if errorlevel 1 exit /b 1
call npm run check
if errorlevel 1 exit /b 1
call npm test
