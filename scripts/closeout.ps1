# Mk2 closeout script (PowerShell)
# Usage: ./scripts/closeout.ps1

Write-Host "Running Mk2 baseline post-check..."
node scripts/baseline-post.ts
if ($LASTEXITCODE -ne 0) {
    Write-Error "Baseline post-check failed. Blocking commit."
    exit 1
}

$summaryPath = Join-Path (Get-Location) ".mk2\summary.json"
if (!(Test-Path $summaryPath)) {
    Write-Error "Summary file missing. Blocking commit."
    exit 2
}

Write-Host "Hashing ledger and receipts..."
$ledgerFile = ".mk2\ledger\events.ndjson"
$receiptsDir = ".mk2\receipts"

if (!(Test-Path $ledgerFile)) {
    Write-Error "Ledger file missing. Blocking commit."
    exit 3
}
if (!(Test-Path $receiptsDir)) {
    Write-Error "Receipts directory missing. Blocking commit."
    exit 4
}

Write-Host "All checks passed. Ready to commit."
# Optionally, add git commit logic here
# git add .mk2/summary.json .mk2/ledger/events.ndjson .mk2/receipts/*.json
# git commit -m "Mk2 closeout: baseline, ledger, receipts integrity verified"
