@echo off
setlocal

REM Auernyx Mk2 CLI launcher (double-click or run from cmd)
REM - Compiles TypeScript
REM - Runs the CLI (daemon-first, local fallback)

pushd "%~dp0"

if not exist "dist\clients\cli\auernyx.js" (
  echo [Mk2] Build output missing. Compiling...
  call npm run compile
  if errorlevel 1 (
    echo [Mk2] Compile failed.
    popd
    pause
    exit /b 1
  )
)

node dist\clients\cli\auernyx.js %*

popd
