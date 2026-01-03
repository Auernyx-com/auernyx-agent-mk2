@echo off
setlocal

REM Auernyx Mk2 single launcher (double-click)
REM Choose:
REM   - Headless daemon (browser UI at /ui)
REM   - VS Code interface (opens repo in VS Code)
REM
REM Optional args for shortcuts:
REM   --headless   Start daemon
REM   --vscode     Open VS Code
REM   --smoke      Run top-down smoke regression

pushd "%~dp0"

set "MODE=%~1"

REM Optional future packaging handoff (keeps one entry point):
REM - If tools\launcher.config.json says launcherTarget=exe and the exe exists,
REM   this script can hand off to it.
REM - Override:
REM     --cmd  force this .cmd behavior
REM     --exe  force exe handoff (if available)

set "CFG_FILE=%~dp0tools\launcher.config.json"
set "launcherTarget="
set "exePath="
set "configError="

if exist "%CFG_FILE%" (
  for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "try { $c=Get-Content -Raw '%CFG_FILE%' | ConvertFrom-Json; Write-Output ('launcherTarget=' + [string]$c.launcherTarget); Write-Output ('exePath=' + [string]$c.exePath) } catch { Write-Output 'configError=1' }" 2^>nul`) do (
    for /f "tokens=1,* delims==" %%A in ("%%L") do set "%%A=%%B"
  )
)

if defined configError (
  echo [Mk2] Warning: tools\launcher.config.json is invalid; ignoring it.
)

if defined exePath set "EXE_PATH=%~dp0%exePath%"

if /I "%MODE%"=="--cmd" goto MENU
if /I "%MODE%"=="--exe" goto RUN_EXE

if /I "%launcherTarget%"=="exe" if defined EXE_PATH if exist "%EXE_PATH%" goto RUN_EXE

if /I "%MODE%"=="--headless" goto HEADLESS
if /I "%MODE%"=="--vscode" goto VSCODE
if /I "%MODE%"=="--smoke" goto SMOKE

:MENU

echo.
echo === Auernyx Mk2 Launcher ===
echo.
echo [1] Headless (daemon + browser UI)
echo [2] VS Code interface
echo [3] Smoke Topdown (regression guard)
echo.
choice /C 123 /N /M "Select mode: "
if errorlevel 3 goto SMOKE
if errorlevel 2 goto VSCODE
if errorlevel 1 goto HEADLESS

:RUN_EXE
if not defined EXE_PATH (
  echo.
  echo [Mk2] No exePath available. Check tools\launcher.config.json.
  goto MENU
)
if not exist "%EXE_PATH%" (
  echo.
  echo [Mk2] Packaged launcher not found:
  echo   %EXE_PATH%
  echo [Mk2] Falling back to .cmd menu.
  goto MENU
)
echo.
echo [Mk2] Handing off to packaged launcher:
echo   %EXE_PATH%
echo.
start "Auernyx Mk2" "%EXE_PATH%" %*
popd
exit /b 0

:SMOKE
echo.
echo [Mk2] Running Smoke Topdown...
echo [Mk2] This will kill stale daemon + locks, start read-only daemon,
echo [Mk2] verify HTTP negotiation, run read-only checks, then run controlled
echo [Mk2] operations locally with --no-daemon --confirm APPLY.
echo.
start "Auernyx Mk2 Smoke Topdown" cmd /k "powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0tools\smoke-topdown.ps1\" & echo. & echo [Mk2] Smoke exit code: %errorlevel% & echo. & pause"
popd
exit /b 0

:HEADLESS
echo.
echo [Mk2] Starting headless daemon...
if not defined AUERNYX_UI_URL set "AUERNYX_UI_URL=http://127.0.0.1:43117/ui"
start "Auernyx Mk2 Daemon" cmd /c "\"%~dp0Start-Mk2.cmd\""
echo [Mk2] Opening Web UI: %AUERNYX_UI_URL%
start "Auernyx Mk2 UI" "%AUERNYX_UI_URL%"
popd
exit /b 0

:VSCODE
echo.
echo [Mk2] Opening VS Code...
set "CODE_EXE="

REM Optional override for non-standard installs.
if defined AUERNYX_VSCODE_EXE set "CODE_EXE=%AUERNYX_VSCODE_EXE%"
if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND
set "CODE_EXE="

where code >nul 2>&1
if not errorlevel 1 (
  REM Open the repo folder; extension activates on startup.
  code "%CD%"
  popd
  exit /b 0
)

where code.cmd >nul 2>&1
if not errorlevel 1 (
  call code.cmd "%CD%"
  popd
  exit /b 0
)

where code-insiders >nul 2>&1
if not errorlevel 1 (
  code-insiders "%CD%"
  popd
  exit /b 0
)

where code-insiders.cmd >nul 2>&1
if not errorlevel 1 (
  call code-insiders.cmd "%CD%"
  popd
  exit /b 0
)

where codium >nul 2>&1
if not errorlevel 1 (
  codium "%CD%"
  popd
  exit /b 0
)

where codium.cmd >nul 2>&1
if not errorlevel 1 (
  call codium.cmd "%CD%"
  popd
  exit /b 0
)

REM Registry App Paths (covers many installs).
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe" /ve 2^>nul ^| find /i "REG_SZ"') do set "CODE_EXE=%%B"
if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND
set "CODE_EXE="
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe" /ve 2^>nul ^| find /i "REG_SZ"') do set "CODE_EXE=%%B"
if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND
set "CODE_EXE="

REM Also check App Paths for common alternates.
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\Code - Insiders.exe" /ve 2^>nul ^| find /i "REG_SZ"') do set "CODE_EXE=%%B"
if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND
set "CODE_EXE="
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\Code - Insiders.exe" /ve 2^>nul ^| find /i "REG_SZ"') do set "CODE_EXE=%%B"
if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND
set "CODE_EXE="
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\VSCodium.exe" /ve 2^>nul ^| find /i "REG_SZ"') do set "CODE_EXE=%%B"
if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND
set "CODE_EXE="
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\VSCodium.exe" /ve 2^>nul ^| find /i "REG_SZ"') do set "CODE_EXE=%%B"
if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND
set "CODE_EXE="

REM Fallback: common VS Code install locations.
if exist "%LocalAppData%\Programs\Microsoft VS Code\Code.exe" set "CODE_EXE=%LocalAppData%\Programs\Microsoft VS Code\Code.exe"
if not defined CODE_EXE if exist "%LocalAppData%\Programs\Microsoft VS Code\bin\code.cmd" set "CODE_EXE=%LocalAppData%\Programs\Microsoft VS Code\bin\code.cmd"
if not defined CODE_EXE if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
if not defined CODE_EXE if exist "%ProgramFiles(x86)%\Microsoft VS Code\Code.exe" set "CODE_EXE=%ProgramFiles(x86)%\Microsoft VS Code\Code.exe"

REM Also support VS Code Insiders.
if not defined CODE_EXE if exist "%LocalAppData%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe" set "CODE_EXE=%LocalAppData%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe"
if not defined CODE_EXE if exist "%LocalAppData%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd" set "CODE_EXE=%LocalAppData%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"
if not defined CODE_EXE if exist "%ProgramFiles%\Microsoft VS Code Insiders\Code - Insiders.exe" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code Insiders\Code - Insiders.exe"
if not defined CODE_EXE if exist "%ProgramFiles(x86)%\Microsoft VS Code Insiders\Code - Insiders.exe" set "CODE_EXE=%ProgramFiles(x86)%\Microsoft VS Code Insiders\Code - Insiders.exe"

REM Also support VSCodium.
if not defined CODE_EXE if exist "%LocalAppData%\Programs\VSCodium\VSCodium.exe" set "CODE_EXE=%LocalAppData%\Programs\VSCodium\VSCodium.exe"
if not defined CODE_EXE if exist "%ProgramFiles%\VSCodium\VSCodium.exe" set "CODE_EXE=%ProgramFiles%\VSCodium\VSCodium.exe"
if not defined CODE_EXE if exist "%ProgramFiles(x86)%\VSCodium\VSCodium.exe" set "CODE_EXE=%ProgramFiles(x86)%\VSCodium\VSCodium.exe"

if defined CODE_EXE if exist "%CODE_EXE%" goto VSCODE_FOUND

echo [Mk2] VS Code not found.
echo [Mk2] Tried:
echo   - code on PATH
echo   - code.cmd / code-insiders
echo   - codium / codium.cmd
echo   - AUERNYX_VSCODE_EXE override
echo   - registry App Paths (Code.exe / Code - Insiders.exe / VSCodium.exe)
echo   - %LocalAppData%\Programs\Microsoft VS Code\Code.exe
echo   - %ProgramFiles%\Microsoft VS Code\Code.exe
echo   - %ProgramFiles(x86)%\Microsoft VS Code\Code.exe
echo   - %LocalAppData%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe
echo   - %LocalAppData%\Programs\VSCodium\VSCodium.exe
echo.
echo [Mk2] Fix option A (recommended): In VS Code, open Command Palette and run:
echo   ^> Shell Command: Install 'code' command in PATH
echo.
echo [Mk2] Fix option A2 (fast override): set a custom path and rerun:
echo   set "AUERNYX_VSCODE_EXE=C:\Path\To\Code.exe"
echo   Launch-Auernyx.cmd --vscode
echo.
echo [Mk2] Fix option B: Install VS Code (User or System) then rerun this launcher.
echo.
pause
popd
exit /b 1


:VSCODE_FOUND
echo [Mk2] Found VS Code: %CODE_EXE%
echo.
echo [Mk2] Opening repo: %CD%
echo.
set "EXT=%CODE_EXE:~-4%"
if /I "%EXT%"==".cmd" (
  call "%CODE_EXE%" "%CD%"
) else (
  start "Auernyx Mk2" "%CODE_EXE%" "%CD%"
)
popd
exit /b 0
