$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$kotlinRoot = Join-Path $repoRoot "branches\kotlin-consumer"

$htmlSrc = Join-Path $kotlinRoot "build\reports\tests\test\index.html"
$xmlSrc = Join-Path $kotlinRoot "build\test-results\test\TEST-ygg.ProofBatteryTest.xml"

if (-not (Test-Path $htmlSrc)) { throw "Missing HTML report: $htmlSrc" }
if (-not (Test-Path $xmlSrc)) { throw "Missing XML report: $xmlSrc" }

$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$dst = Join-Path $repoRoot ("artifacts\kotlin_evidence\" + $ts)
New-Item -ItemType Directory -Force $dst | Out-Null

Copy-Item $htmlSrc (Join-Path $dst "index.html") -Force
Copy-Item $xmlSrc (Join-Path $dst "ProofBatteryTest.xml") -Force

$hashIndex = Get-FileHash (Join-Path $dst "index.html") -Algorithm SHA256
$hashXml = Get-FileHash (Join-Path $dst "ProofBatteryTest.xml") -Algorithm SHA256

$hashFile = Join-Path $dst "sha256.txt"
@(
    ("SHA256  index.html           " + $hashIndex.Hash),
    ("SHA256  ProofBatteryTest.xml " + $hashXml.Hash)
) | Set-Content -Path $hashFile -Encoding ASCII

Write-Host ("Archived Kotlin proof battery evidence to: " + $dst)
Write-Host ($hashIndex.Path + "  " + $hashIndex.Hash)
Write-Host ($hashXml.Path + "  " + $hashXml.Hash)

