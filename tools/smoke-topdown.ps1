# Auernyx Mk2 — Top-down regression smoke
# Ordered steps:
#  1) Kill stale daemon + locks
#  2) Start daemon read-only
#  3) Verify HTTP negotiation
#  4) Run CLI read-only checks
#  5) Run controlled ops locally (--no-daemon --apply)
#  6) Assert genesis.json exists
#  7) Exit non-zero on any failure

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$base = "http://127.0.0.1:43117"
$daemonProc = $null

$logsDir = Join-Path $repoRoot 'logs'
$logPath = Join-Path $logsDir 'smoke-topdown.log'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
"[SMOKE] $(Get-Date -Format o)" | Out-File -FilePath $logPath -Encoding utf8

function Log([string]$message) {
  $message | Out-File -FilePath $logPath -Encoding utf8 -Append
  Write-Host $message
}

function RequireCommand([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command not found on PATH: $name"
  }
}

function Fail([string]$message) {
  Log "[FAIL] $message"
  $script:failed = $true
  $script:failedThisStep = $true
}

function Ok([string]$message) {
  Log "[ OK ] $message"
}

function TryStep([string]$label, [scriptblock]$fn) {
  Log "[STEP] $label"
  try {
    & $fn
    if (-not $script:failedThisStep) {
      Ok $label
    }
  }
  catch {
    Fail "$label :: $($_.Exception.Message)"
  }
  finally {
    $script:failedThisStep = $false
  }
}

function StopProcessById([int]$processId) {
  try {
    $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($p) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }
  catch {
    # best-effort
  }
}

function GetDaemonLockPath([string]$root) {
  $normalized = (Resolve-Path $root).Path.ToLowerInvariant()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
  $hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
  $short = $hash.Substring(0, 16)
  return Join-Path $env:TEMP ("auernyx-mk2-daemon-$short.lock")
}

function KillDaemonOnPort([int]$port) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess -gt 0) {
        StopProcessById $c.OwningProcess
      }
    }
  }
  catch {
    # Fallback (works on more Windows environments)
    try {
      $lines = netstat -ano | Select-String ":$port\s+.*LISTENING\s+\d+$" | ForEach-Object { $_.Line }
      foreach ($line in $lines) {
        $pidStr = ($line -split '\s+')[-1]
        $processId = 0
        if ([int]::TryParse($pidStr, [ref]$processId) -and $processId -gt 0) {
          StopProcessById $processId
        }
      }
    }
    catch {
      # best-effort
    }
  }
}

function RemoveIfExists([string]$path) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -Force -LiteralPath $path -ErrorAction SilentlyContinue
  }
}

function WaitForDaemonReady([string]$healthUrl) {
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      Invoke-WebRequest -Uri $healthUrl -TimeoutSec 1 -UseBasicParsing | Out-Null
      $ready = $true
      break
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  }

  if (-not $ready) {
    throw "Daemon did not become ready at $healthUrl"
  }
}

function AssertContentType([string]$url, [string]$accept, [string]$mustContain) {
  $headers = @{}
  if ($accept) { $headers['Accept'] = $accept }

  $r = Invoke-WebRequest -Uri $url -Headers $headers -TimeoutSec 4 -UseBasicParsing
  $ct = [string]$r.Headers['Content-Type']
  if (-not ($ct.ToLowerInvariant().Contains($mustContain.ToLowerInvariant()))) {
    throw "Unexpected content-type for $url (Accept=$accept): $ct (expected contains: $mustContain)"
  }
}

function RunCli([string]$label, [string]$cliArgs, [bool]$local, [bool]$writeEnabled) {
  $envBefore = $env:AUERNYX_WRITE_ENABLED

  try {
    if ($writeEnabled) {
      $env:AUERNYX_WRITE_ENABLED = '1'
    }
    else {
      if (Test-Path Env:AUERNYX_WRITE_ENABLED) { Remove-Item Env:AUERNYX_WRITE_ENABLED -ErrorAction SilentlyContinue }
    }

    $cmd = "node .\\dist\\clients\\cli\\auernyx.js $cliArgs"
    if ($local) {
      if ($cmd -notmatch "--no-daemon") {
        $cmd = "$cmd --no-daemon"
      }
    }

    Log "[CLI ] $label :: $cmd"
    $output = (Invoke-Expression $cmd 2>&1 | Out-String)
    if ($output.Trim().Length -gt 0) {
      Log "[OUT ] $label :: ${output}".TrimEnd()
    }

    if ($LASTEXITCODE -ne 0) {
      throw "exit $LASTEXITCODE"
    }
  }
  finally {
    if ($null -eq $envBefore) {
      if (Test-Path Env:AUERNYX_WRITE_ENABLED) { Remove-Item Env:AUERNYX_WRITE_ENABLED -ErrorAction SilentlyContinue }
    }
    else {
      $env:AUERNYX_WRITE_ENABLED = $envBefore
    }
  }

  Ok $label
}

$script:failed = $false
$script:failedThisStep = $false

try {
  RequireCommand 'node'

  # Ensure build output exists.
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\\core\\server.js'))) {
    RequireCommand 'npm'
    TryStep 'Build (npm run compile)' {
      & npm run compile | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
    }
  }

  # 1) Kill stale daemon + locks
  TryStep 'Kill stale daemon + locks' {
    $daemonLock = GetDaemonLockPath $repoRoot
    if (Test-Path -LiteralPath $daemonLock) {
      try {
        $raw = (Get-Content -LiteralPath $daemonLock -ErrorAction SilentlyContinue | Select-Object -First 1)
        $daemonPid = [int]($raw -split '\\s+')[0]
        if ($daemonPid -gt 0) { StopProcessById $daemonPid }
      }
      catch {
        # ignore
      }

      RemoveIfExists $daemonLock
    }

    KillDaemonOnPort 43117

    RemoveIfExists (Join-Path $repoRoot 'logs\\ledger.ndjson.lock')
    RemoveIfExists (Join-Path $repoRoot 'logs\\governance.lock.json')
  }

  # 2) Start daemon read-only
  TryStep 'Start daemon read-only' {
    if (Test-Path Env:AUERNYX_WRITE_ENABLED) { Remove-Item Env:AUERNYX_WRITE_ENABLED -ErrorAction SilentlyContinue }

    $daemonProc = Start-Process -FilePath node -ArgumentList @('dist\\core\\server.js') -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden
    Log "[DAEMON] started pid=$($daemonProc.Id)"
    WaitForDaemonReady "$base/health"
  }

  # 3) Verify HTTP negotiation
  TryStep 'Verify HTTP negotiation' {
    # Default: should render HTML (browser-friendly)
    AssertContentType "$base/" $null 'text/html'

    # Explicit negotiation
    AssertContentType "$base/" 'application/json' 'application/json'
    AssertContentType "$base/" 'text/html' 'text/html'

    AssertContentType "$base/ui" $null 'text/html'
    AssertContentType "$base/ui" 'text/html' 'text/html'
  }

  # 4) Run CLI read-only checks
  TryStep 'Run CLI read-only checks' {
    RunCli 'scan' 'scan --reason "smoke-topdown"' $false $false
    RunCli 'memory' 'memory --reason "smoke-topdown"' $false $false
  }

  # 5) Run controlled ops locally (--no-daemon --apply)
  TryStep 'Run controlled ops locally' {
    RunCli 'baseline post (local)' 'baseline post --reason "smoke-topdown"' $true $false
    RunCli 'baseline pre (local, apply, allow-dirty)' 'baseline pre --reason "smoke-topdown" --apply --allow-dirty' $true $true
  }

  # 6) Assert genesis.json exists
  TryStep 'Assert genesis.json exists' {
    $genesis = Join-Path $repoRoot '.auernyx\\provenance\\genesis.json'
    if (-not (Test-Path -LiteralPath $genesis)) {
      throw "Missing genesis.json at $genesis"
    }
  }
}
catch {
  Fail "Unhandled exception: $($_.Exception.Message)"
}
finally {
  if ($daemonProc -and -not $daemonProc.HasExited) {
    Stop-Process -Id $daemonProc.Id -Force -ErrorAction SilentlyContinue
  }
}

# 7) Exit non-zero on any failure
if ($script:failed) {
  Log "[SMOKE] FAIL (see $logPath)"
  exit 2
}

Log "[SMOKE] PASS"
exit 0
