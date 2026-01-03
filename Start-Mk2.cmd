@echo off
setlocal

REM Auernyx Mk2 launcher (double-click)
REM - Compiles TypeScript
REM - Starts the daemon

pushd "%~dp0"
echo [Mk2] Compiling...
call npm run compile
if errorlevel 1 (
  echo [Mk2] Compile failed.
  popd
  pause
  exit /b 1
)

echo [Mk2] Starting daemon...
echo [Mk2] If AUERNYX_SECRET is configured, clients must send x-auernyx-secret.
if not defined AUERNYX_UI_URL set "AUERNYX_UI_URL=http://127.0.0.1:43117/ui"
echo [Mk2] Web UI: %AUERNYX_UI_URL%
echo [Mk2] Note: Read-only by default. Enable writes with AUERNYX_WRITE_ENABLED=1
echo.
node dist\core\server.js

popd
pause
