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
echo.
node dist\core\server.js

popd
pause
