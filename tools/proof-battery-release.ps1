param(
    [Parameter(Mandatory = $false)]
    [string]$TagName = "yggdrasil-trunk@v1",

    [Parameter(Mandatory = $false)]
    [string]$EvidenceRoot = "artifacts\\release_evidence"
)

$ErrorActionPreference = "Continue"

function Get-LatestReceiptDir {
    $d = Get-ChildItem .\.auernyx\receipts -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    return $d
}

function Copy-LatestReceipt([string]$label, [string]$evidenceDir) {
    $d = Get-LatestReceiptDir
    if (-not $d) { return $null }

    $dest = Join-Path $evidenceDir ("{0}_{1}" -f $label, $d.Name)
    Copy-Item $d.FullName $dest -Recurse -Force
    return $dest
}

function Run-Step([string]$label, [string]$command, [string]$evidenceDir) {
    $beforeDir = Get-LatestReceiptDir
    $before = if ($beforeDir) { $beforeDir.Name } else { $null }

    $out = Invoke-Expression $command 2>&1 | Out-String
    $code = $LASTEXITCODE

    $afterDir = Get-LatestReceiptDir
    $after = if ($afterDir) { $afterDir.Name } else { $null }
    $copied = Copy-LatestReceipt $label $evidenceDir

    return [pscustomobject]@{
        label            = $label
        command          = $command
        exit_code        = $code
        receipt_dir_name = $after
        receipt_copied_to = $copied
        stdout           = ("" + $out).Trim()
        before_receipt   = $before
    }
}

# --- Main ---
$repo = (Get-Location).Path
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$evidenceDir = Join-Path $repo (Join-Path $EvidenceRoot ("{0}_{1}" -f $ts, ($TagName -replace "[^A-Za-z0-9@._-]", "_")))
New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null

$head = (git rev-parse HEAD).Trim()
$branch = (git rev-parse --abbrev-ref HEAD).Trim()

$steps = @()

# 01: Preview only
Remove-Item Env:AUERNYX_WRITE_ENABLED -ErrorAction SilentlyContinue
$steps += Run-Step "01_preview_only" 'node .\\dist\\clients\\cli\\auernyx.js "auernyx baseline pre" --no-daemon --approve-reason "release evidence preview"' $evidenceDir

# 02: Apply without env
Remove-Item Env:AUERNYX_WRITE_ENABLED -ErrorAction SilentlyContinue
$steps += Run-Step "02_apply_without_env" 'node .\\dist\\clients\\cli\\auernyx.js "auernyx baseline pre" --no-daemon --apply --allow-dirty --approve-reason "release evidence apply no env"' $evidenceDir

# 03: Dirty tree without allow-dirty
Set-Content -Path .\\tmp_dirty_release_evidence.txt -Value "dirty" -Encoding utf8
$env:AUERNYX_WRITE_ENABLED = "1"
$steps += Run-Step "03_dirty_no_allow" 'node .\\dist\\clients\\cli\\auernyx.js "auernyx baseline pre" --no-daemon --apply --approve-reason "release evidence dirty"' $evidenceDir
Remove-Item .\\tmp_dirty_release_evidence.txt -Force -ErrorAction SilentlyContinue

# 04: Canon not ignored (temporary .gitignore edit)
Copy-Item .\\.gitignore .\\.gitignore.bak.release -Force
try {
    $filtered = Get-Content .\\.gitignore | Where-Object {
        $t = $_.Trim()
        $t -ne '.canon/' -and $t -ne 'var/canon/'
    }
    Set-Content -Path .\\.gitignore -Value $filtered -Encoding utf8

    $env:AUERNYX_WRITE_ENABLED = "1"
    $steps += Run-Step "04_canon_not_ignored" 'node .\\dist\\clients\\cli\\auernyx.js "auernyx baseline pre" --no-daemon --apply --allow-dirty --approve-reason "release evidence canon"' $evidenceDir
}
finally {
    Move-Item .\\.gitignore.bak.release .\\.gitignore -Force
}

$manifest = [pscustomobject]@{
    tag          = $TagName
    head_commit  = $head
    branch       = $branch
    evidence_dir = $evidenceDir
    generated_utc = (Get-Date).ToUniversalTime().ToString("o")
    steps        = $steps
}

$manifest | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $evidenceDir "manifest.json") -Encoding utf8

Write-Output $evidenceDir
