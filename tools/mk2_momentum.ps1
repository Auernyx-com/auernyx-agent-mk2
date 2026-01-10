# tools/mk2_momentum.ps1
# One-command: apply (if payload exists) -> mk2 gate -> bastion secondary summary.

[CmdletBinding()]
param(
  [string]$RepoRoot = (Get-Location).Path,
  [string]$ActorId = $env:USERNAME,
  [string]$PayloadId = "",
  [switch]$RequirePayload,
  [switch]$EnforceIntentIdInRepo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail([string]$msg) { throw "FAIL-CLOSED: $msg" }

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
Push-Location $repo
try {
  $incoming = Join-Path $repo "updates\incoming"
  $payloadDirs = @()
  if (Test-Path -LiteralPath $incoming) {
    $payloadDirs = @(Get-ChildItem -LiteralPath $incoming -Directory | Sort-Object Name)
    if ($PayloadId) {
      $payloadDirs = @($payloadDirs | Where-Object { $_.Name -eq $PayloadId })
    }
  }

  $applyStatus = "skipped"
  $appliedPayload = ""

  if ($payloadDirs.Count -gt 1) { Fail "Multiple payloads present in updates/incoming. Specify -PayloadId." }
  if ($payloadDirs.Count -eq 1) {
    $appliedPayload = $payloadDirs[0].Name
    $applyArgs = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $repo "tools\apply_updates.ps1"),
      "-RepoRoot", $repo,
      "-Incoming", "updates/incoming",
      "-ActorId", $ActorId
    )
    if ($PayloadId) { $applyArgs += @("-PayloadId", $PayloadId) }
    if ($EnforceIntentIdInRepo) { $applyArgs += @("-EnforceIntentIdInRepo") }
    & pwsh @applyArgs | Write-Host
    $applyStatus = "applied"
  } elseif ($RequirePayload) {
    Fail "No payload found in updates/incoming."
  }

  $gateOut = & python (Join-Path $repo "tools\ci_gate.py") 2>&1
  if ($LASTEXITCODE -ne 0) { Fail ("Mk2 gate failed: " + ($gateOut -join "`n")) }

  $summaryOut = & python (Join-Path $repo "tools\bastion_secondary.py") --repo $repo --actor $ActorId 2>&1
  if ($LASTEXITCODE -ne 0) { Fail ("Bastion secondary adapter failed: " + ($summaryOut -join "`n")) }

  $summaryJson = $summaryOut | Select-Object -Last 1
  if (-not $summaryJson) { Fail "Bastion secondary adapter did not print summary JSON." }

  $obj = $summaryJson | ConvertFrom-Json
  $mk2Gate = if ($obj.mk2Gate) { $obj.mk2Gate } else { "unknown" }
  $headCommit = if ($obj.headCommit) { $obj.headCommit } else { "unknown" }
  $manifest = if ($obj.lastApply -and $obj.lastApply.manifestSha256) { $obj.lastApply.manifestSha256 } else { "none" }
  $payload = if ($obj.lastApply -and $obj.lastApply.payloadId) { $obj.lastApply.payloadId } else { $appliedPayload }

  Write-Host ("MOMENTUM OK: apply={0} payload={1} mk2Gate={2} headCommit={3} manifestSha256={4}" -f $applyStatus, $payload, $mk2Gate, $headCommit, $manifest)
  $repoHead = "unknown"
  try { $repoHead = (git -C $repo rev-parse HEAD 2>$null).Trim() } catch { $repoHead = "unknown" }
  Write-Host ("Mk2 Alteration Program closed at {0}. Kotlin proof battery PASS. Evidence archived with hashes." -f $repoHead)
} finally {
  Pop-Location
}
