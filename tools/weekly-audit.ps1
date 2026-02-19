#requires -Version 5.1
param()

$ErrorActionPreference = "Stop"

function Fail($msg, $code = 1) {
  Write-Host "[WEEKLY_AUDIT] ERROR: $msg"
  exit $code
}

if (!(Test-Path ".git") -or !(Test-Path "package.json")) {
  Fail "Run this from the repo root (missing .git or package.json)." 2
}

if (!(Test-Path "dist/clients/cli/auernyx.js")) {
  Write-Host "[WEEKLY_AUDIT] ERROR: dist/clients/cli/auernyx.js is missing."
  Write-Host "[WEEKLY_AUDIT] ACTION: Run: npm run compile"
  exit 3
}

$dateUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$shortSha = (git rev-parse --short HEAD) 2>$null
if (-not $shortSha) { $shortSha = "unknown" }

$logDir = "logs/audit"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("weekly-audit_{0}_{1}.txt" -f $dateUtc, $shortSha)

Start-Transcript -Path $logFile -Append | Out-Null

try {
  Write-Host "============================================================"
  Write-Host "[WEEKLY_AUDIT] START"
  Write-Host ("[WEEKLY_AUDIT] date_utc={0}" -f $dateUtc)
  Write-Host ("[WEEKLY_AUDIT] head={0}" -f $shortSha)
  Write-Host ("[WEEKLY_AUDIT] branch={0}" -f (git rev-parse --abbrev-ref HEAD))
  Write-Host ("[WEEKLY_AUDIT] repo={0}" -f (Split-Path -Leaf (Get-Location)))
  Write-Host "============================================================"
  Write-Host ""

  Write-Host ("[WEEKLY_AUDIT] AUERNYX_SECRET: {0}" -f ($(if ([string]::IsNullOrWhiteSpace($env:AUERNYX_SECRET)) { "NOT_SET" } else { "SET" })))
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 1/4: Governance CI gate"
  python3 tools/ci_gate.py
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 2/4: npm verify"
  npm run verify
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 3/4: Mnēma cross-check (memory) [no-daemon]"
  node dist/clients/cli/auernyx.js memory --reason "weekly audit" --no-daemon
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 4/4: Git changes (last 7 days)"
  git log --since="7 days ago" --name-status
  Write-Host ""

  Write-Host "============================================================"
  Write-Host "[WEEKLY_AUDIT] PASS"
  Write-Host ("[WEEKLY_AUDIT] log={0}" -f $logFile)
  Write-Host "============================================================"
} finally {
  Stop-Transcript | Out-Null
}
