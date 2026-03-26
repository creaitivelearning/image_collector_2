@echo off
setlocal EnableExtensions

title Image Collector 2 Launcher

cd /d "%~dp0"
if errorlevel 1 goto :folder_error

where node >nul 2>&1
if errorlevel 1 goto :missing_node

where npm >nul 2>&1
if errorlevel 1 goto :missing_npm

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :install_error
)

echo Starting Image Collector 2...
start "Image Collector 2 Server" cmd /k "cd /d ""%~dp0"" && echo Image Collector 2 server window. Leave this open while using the app. && node src\server.js"

echo Waiting for the local server...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline=(Get-Date).AddSeconds(20);" ^
  "while((Get-Date) -lt $deadline) {" ^
  "  try {" ^
  "    $response = Invoke-WebRequest -UseBasicParsing http://localhost:3000/health -TimeoutSec 2;" ^
  "    if ($response.StatusCode -eq 200) { exit 0 }" ^
  "  } catch {}" ^
  "  Start-Sleep -Milliseconds 500" ^
  "}" ^
  "exit 1"
if errorlevel 1 goto :server_error

start "" "http://localhost:3000"
echo Image Collector 2 is opening in your browser.
echo If the browser does not open, go to http://localhost:3000 manually.
timeout /t 3 /nobreak >nul
exit /b 0

:folder_error
echo The launcher could not open the project folder.
pause
exit /b 1

:missing_node
echo Node.js was not found on this PC.
echo Install Node.js 18 or newer from https://nodejs.org/ and then try again.
pause
exit /b 1

:missing_npm
echo npm was not found on this PC.
echo Reinstall Node.js 18 or newer from https://nodejs.org/ and then try again.
pause
exit /b 1

:install_error
echo npm install failed.
echo Read the error above, fix it, and then run this launcher again.
pause
exit /b 1

:server_error
echo The local server did not respond within 20 seconds.
echo Check the "Image Collector 2 Server" window for the actual error.
pause
exit /b 1
