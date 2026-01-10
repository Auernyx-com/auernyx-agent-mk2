# tools/apply_updates.ps1
# Fail-closed update applier for Mk2 update payloads.
# Applies ONE payload from updates/incoming/, logs to NDJSON, moves payload to quarantine.

[CmdletBinding()]
param(
  [string]$RepoRoot = (Get-Location).Path,
  [string]$Incoming = "updates/incoming",
  [string]$QuarantineRoot = "C:\_QUARANTINE_",
  [string]$ActorId = $env:USERNAME,
  [string]$PayloadId = "",  # optional: specify which payload folder to apply
  [switch]$EnforceIntentIdInRepo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Sha256File($Path) {
  (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function Fail($Msg) {
  throw "FAIL-CLOSED: $Msg"
}

function SafeRelPath($Rel) {
  if ($Rel -match "^[a-zA-Z]:\\") { return $false }
  if ($Rel.StartsWith("/")) { return $false }
  if ($Rel -match "\.\.") { return $false }
  if ($Rel -match "^(?:\.git/|\.git\\)") { return $false }
  return $true
}

$repo = (Resolve-Path $RepoRoot).Path
$nested = Join-Path $repo "updates\updates"
if (Test-Path $nested) {
  Fail "Nested updates\updates detected. Extract payload zips to repo root, not inside updates\."
}
$incomingPath = Join-Path $repo $Incoming

if (!(Test-Path $incomingPath)) {
  Fail "Incoming folder not found: $incomingPath"
}

$payloadDirs = @(Get-ChildItem -Path $incomingPath -Directory | Sort-Object Name)
if ($PayloadId) {
  $payloadDirs = $payloadDirs | Where-Object { $_.Name -eq $PayloadId }
  if ($payloadDirs.Count -ne 1) { Fail "PayloadId not found in incoming: $PayloadId" }
} else {
  if ($payloadDirs.Count -eq 0) { Fail "No payload found in updates/incoming." }
  if ($payloadDirs.Count -gt 1) { Fail "Multiple payloads present. Specify -PayloadId to apply one." }
}

$payloadDir = $payloadDirs[0].FullName
$payloadName = $payloadDirs[0].Name

$manifest = Join-Path $payloadDir "manifest.json"
$manifestSha = Join-Path $payloadDir "manifest.sha256"
$filesRoot = Join-Path $payloadDir "files"

if (!(Test-Path $manifest))    { Fail "Missing manifest.json in payload: $payloadDir" }
if (!(Test-Path $manifestSha)) { Fail "Missing manifest.sha256 in payload: $payloadDir" }
if (!(Test-Path $filesRoot))   { Fail "Missing files/ folder in payload: $payloadDir" }

$expectedManifestHash = (Get-Content $manifestSha -Raw).Trim().ToLower()
$actualManifestHash = Sha256File $manifest
if ($expectedManifestHash -ne $actualManifestHash) {
  Fail "manifest.sha256 mismatch. expected=$expectedManifestHash actual=$actualManifestHash"
}

$man = Get-Content $manifest -Raw | ConvertFrom-Json
if (!$man.payloadId) { Fail "manifest.payloadId missing" }
if ($man.payloadId -ne $payloadName) { Fail "payload folder name must equal manifest.payloadId" }
if (!$man.intentId)  { Fail "manifest.intentId missing" }
if (!$man.files)     { Fail "manifest.files missing/empty" }

if ($EnforceIntentIdInRepo) {
  $intentId = [string]$man.intentId
  if ($intentId -eq "0000000000000-deadbeef") {
    Fail "manifest.intentId is placeholder (0000000000000-deadbeef); replace with a real intentId before applying with -EnforceIntentIdInRepo."
  }
  $intentDir = Join-Path $repo "governance\alteration-program\intent"
  if (!(Test-Path $intentDir)) { Fail "Intent directory missing: $intentDir" }
  $matches = Get-ChildItem -LiteralPath $intentDir -Filter "$intentId*.json" -File -ErrorAction SilentlyContinue
  if ($matches.Count -lt 1) { Fail "manifest.intentId not found in repo intent directory: $intentId" }
}

$appliedCount = 0
foreach ($f in $man.files) {
  if (!$f.relPath -or !$f.sha256 -or ($null -eq $f.bytes)) { Fail "manifest.files entry missing relPath/sha256/bytes" }
  $rel = [string]$f.relPath
  if (!(SafeRelPath $rel)) { Fail "Unsafe relPath in manifest: $rel" }

  $src = Join-Path $filesRoot $rel
  if (!(Test-Path $src)) { Fail "File listed in manifest not found in payload: $rel" }

  $srcInfo = Get-Item $src
  if ($srcInfo.Length -ne [int64]$f.bytes) { Fail "Byte length mismatch for $rel" }

  $srcHash = Sha256File $src
  if ($srcHash -ne ([string]$f.sha256).ToLower()) { Fail "SHA256 mismatch for $rel" }

  $dst = Join-Path $repo $rel
  $dstDir = Split-Path $dst -Parent
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null

  Copy-Item -Force -Path $src -Destination $dst
  $appliedCount++
}

$logPath = Join-Path $repo "governance/alteration-program/logs/update_apply.ndjson"
New-Item -ItemType Directory -Force -Path (Split-Path $logPath -Parent) | Out-Null
if (!(Test-Path -LiteralPath $logPath)) { New-Item -ItemType File -Path $logPath | Out-Null }

$branchName = ""
try { $branchName = (git -C $repo rev-parse --abbrev-ref HEAD) } catch { $branchName = "unknown" }

$event = [ordered]@{
  event          = "update_applied"
  payloadId      = $man.payloadId
  intentId       = $man.intentId
  branch         = $branchName
  appliedAt      = (Get-Date).ToUniversalTime().ToString("o")
  actorId        = $ActorId
  result         = "success"
  filesApplied   = $appliedCount
  manifestSha256 = $actualManifestHash
  notes          = "payload moved to quarantine; updates/incoming cleared"
}

($event | ConvertTo-Json -Compress) | Add-Content -Path $logPath

$stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$quarantineTarget = Join-Path $QuarantineRoot ("{0}-updates-{1}" -f $payloadName, $stamp)
New-Item -ItemType Directory -Force -Path $QuarantineRoot | Out-Null
Move-Item -Force -Path $payloadDir -Destination $quarantineTarget

$remaining = @(Get-ChildItem -Path $incomingPath -Directory)
if ($remaining.Count -ne 0) { Fail "updates/incoming not empty after apply." }

Write-Host "APPLY OK: payload=$payloadName filesApplied=$appliedCount quarantined=$quarantineTarget"
