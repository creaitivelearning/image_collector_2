@echo off
setlocal

cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)

start "Image Collector 2 Server" cmd /k "cd /d ""%~dp0"" && node src\server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"
exit /b 0

:error
echo Image Collector 2 could not install dependencies.
exit /b 1
