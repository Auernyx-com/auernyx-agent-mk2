# Creates a Desktop shortcut to Launch-Auernyx.cmd with a custom icon.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\create-launcher-shortcut.ps1
#
# Notes:
# - Windows cannot set an icon directly on .cmd; this creates a .lnk.

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$configPath = Join-Path $repoRoot 'tools\launcher.config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing launcher config: $configPath"
}

$cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json

function RequireNonEmpty([string]$name, $value) {
  $s = [string]$value
  if ([string]::IsNullOrWhiteSpace($s)) {
    throw "Invalid launcher config: missing or empty '$name' in $configPath"
  }
  return $s
}

$launcherTarget = RequireNonEmpty 'launcherTarget' $cfg.launcherTarget
$cmdPathRel = RequireNonEmpty 'cmdPath' $cfg.cmdPath
$exePathRel = RequireNonEmpty 'exePath' $cfg.exePath
$iconSourcePngRel = RequireNonEmpty 'iconSourcePng' $cfg.iconSourcePng
$iconRel = RequireNonEmpty 'iconPath' $cfg.iconPath

$cmdPath = Join-Path $repoRoot $cmdPathRel
$exePath = Join-Path $repoRoot $exePathRel
$iconSourcePng = Join-Path $repoRoot $iconSourcePngRel
$icon = Join-Path $repoRoot $iconRel

$shortcutName = [string]$cfg.shortcutName
if ([string]::IsNullOrWhiteSpace($shortcutName)) { $shortcutName = 'Auernyx Mk2' }

$launcher = $cmdPath
if ($launcherTarget -eq 'exe' -and (Test-Path -LiteralPath $exePath)) {
  $launcher = $exePath
}

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Launcher not found: $launcher"
}

if (-not (Test-Path -LiteralPath $iconSourcePng)) {
  throw "Icon source PNG not found: $iconSourcePng"
}

if (-not (Test-Path -LiteralPath $icon)) {
  Write-Host "[shortcut] Icon not found; generating: $icon" -ForegroundColor Yellow
  & node .\tools\make-ico.js "$iconSourcePng" "$icon" | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Icon generation failed (exit $LASTEXITCODE)" }
}

$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$linkPath = Join-Path $desktop ("$shortcutName.lnk")

$exists = Test-Path -LiteralPath $linkPath

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($linkPath)
$sc.TargetPath = $launcher
$sc.WorkingDirectory = $repoRoot
$sc.IconLocation = "$icon,0"
$sc.WindowStyle = 1
$sc.Description = 'Auernyx Mk2 Launcher'
$sc.Save()

Write-Host ("[shortcut] " + $(if ($exists) { 'Updated' } else { 'Created' }) + ": $linkPath") -ForegroundColor Green
Write-Host "[shortcut] Icon: $icon" -ForegroundColor Green
