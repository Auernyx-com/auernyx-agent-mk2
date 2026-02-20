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
if ($LASTEXITCODE -ne 0 -or -not $shortSha) {
  Write-Host "[WEEKLY_AUDIT] WARN: git rev-parse --short HEAD failed; using 'unknown' for SHA."
  $shortSha = "unknown"
}

$logDir = "logs/audit"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("weekly-audit_{0}_{1}.txt" -f $dateUtc, $shortSha)

Start-Transcript -Path $logFile -Append | Out-Null

try {
  Write-Host "============================================================"
  Write-Host "[WEEKLY_AUDIT] START"
  Write-Host ("[WEEKLY_AUDIT] date_utc={0}" -f $dateUtc)
  Write-Host ("[WEEKLY_AUDIT] head={0}" -f $shortSha)
  $branch = (git rev-parse --abbrev-ref HEAD) 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $branch) {
    Write-Host "[WEEKLY_AUDIT] WARN: git rev-parse --abbrev-ref HEAD failed; branch unknown."
    $branch = "unknown"
  }
  Write-Host ("[WEEKLY_AUDIT] branch={0}" -f $branch)
  Write-Host ("[WEEKLY_AUDIT] repo={0}" -f (Split-Path -Leaf (Get-Location)))
  Write-Host "============================================================"
  Write-Host ""

  Write-Host ("[WEEKLY_AUDIT] AUERNYX_SECRET: {0}" -f ($(if ([string]::IsNullOrWhiteSpace($env:AUERNYX_SECRET)) { "NOT_SET" } else { "SET" })))
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 1/4: Governance CI gate"
  if ($env:MK2_BASE_REF) {
    python3 tools/ci_gate.py
    if ($LASTEXITCODE -ne 0) { Fail "python3 tools/ci_gate.py failed with exit code $LASTEXITCODE" $LASTEXITCODE }
  } else {
    $authChanges = (git status --porcelain -- governance/alteration-program/authorization/records) 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "git status failed (exit $LASTEXITCODE)." $LASTEXITCODE }
    if ([string]::IsNullOrWhiteSpace($authChanges)) {
      Write-Host "[WEEKLY_AUDIT] INFO: No local authorization record changes detected; skipping Governance CI gate."
      Write-Host "[WEEKLY_AUDIT] INFO: To run the gate against a specific diff, set MK2_BASE_REF before running tools/weekly-audit.ps1."
    } else {
      python3 tools/ci_gate.py
      if ($LASTEXITCODE -ne 0) { Fail "python3 tools/ci_gate.py failed with exit code $LASTEXITCODE" $LASTEXITCODE }
    }
  }
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 2/4: npm verify"
  npm run verify
  if ($LASTEXITCODE -ne 0) { Fail "npm run verify failed with exit code $LASTEXITCODE" $LASTEXITCODE }
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 3/4: Mnēma cross-check (memory) [no-daemon]"
  node dist/clients/cli/auernyx.js memory --reason "weekly audit" --no-daemon
  if ($LASTEXITCODE -ne 0) { Fail "auernyx memory check failed with exit code $LASTEXITCODE" $LASTEXITCODE }
  Write-Host ""

  Write-Host "[WEEKLY_AUDIT] Step 4/4: Git changes (last 7 days)"
  git log --since="7 days ago" --name-status
  if ($LASTEXITCODE -ne 0) { Fail "git log failed with exit code $LASTEXITCODE" $LASTEXITCODE }
  Write-Host ""

  Write-Host "============================================================"
  Write-Host "[WEEKLY_AUDIT] PASS"
  Write-Host ("[WEEKLY_AUDIT] log={0}" -f $logFile)
  Write-Host "============================================================"
} finally {
  Stop-Transcript | Out-Null
}
