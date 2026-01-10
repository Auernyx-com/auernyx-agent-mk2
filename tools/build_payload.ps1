\
# tools/build_payload.ps1
# Creates a single-use updates payload from a staging folder of files.
# Output: updates/incoming/<payloadId>/manifest.json + manifest.sha256 + files/<tree>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$StagingRoot,
  [Parameter(Mandatory=$true)][string]$IncomingRoot,
  [Parameter(Mandatory=$true)][string]$IntentId,
  [string]$Source = "manual",
  [string]$PayloadId = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Sha256File($Path) {
  (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

if (-not (Test-Path $StagingRoot)) { throw "StagingRoot not found: $StagingRoot" }
if (-not (Test-Path $IncomingRoot)) { New-Item -ItemType Directory -Force -Path $IncomingRoot | Out-Null }

if (-not $PayloadId) {
  $PayloadId = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss") + "-" + ([guid]::NewGuid().ToString("N").Substring(0,8))
}

$payloadDir = Join-Path $IncomingRoot $PayloadId
$filesDir = Join-Path $payloadDir "files"
New-Item -ItemType Directory -Force -Path $filesDir | Out-Null

$files = Get-ChildItem -Path $StagingRoot -Recurse -File
if ($files.Count -eq 0) { throw "No files found in staging root." }

$manifestFiles = @()
foreach ($f in $files) {
  $rel = $f.FullName.Substring($StagingRoot.Length).TrimStart('\','/')
  $dst = Join-Path $filesDir $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
  Copy-Item -Force -Path $f.FullName -Destination $dst

  $manifestFiles += [ordered]@{
    relPath = $rel.Replace('\','/')
    sha256  = (Sha256File $dst)
    bytes   = $f.Length
  }
}

$manifest = [ordered]@{
  payloadId  = $PayloadId
  intentId   = $IntentId
  createdAt  = (Get-Date).ToUniversalTime().ToString("o")
  source     = $Source
  files      = $manifestFiles
}

$manifestPath = Join-Path $payloadDir "manifest.json"
$manifest | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 -FilePath $manifestPath

$manifestSha = Sha256File $manifestPath
$shaPath = Join-Path $payloadDir "manifest.sha256"
$manifestSha | Out-File -Encoding ascii -FilePath $shaPath

Write-Host "PAYLOAD BUILT: $payloadDir"
Write-Host "manifest.sha256: $manifestSha"
