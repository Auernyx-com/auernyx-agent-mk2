[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-TrunkRoot {
  $here = (Resolve-Path -LiteralPath $PSScriptRoot).Path
  return (Resolve-Path -LiteralPath (Join-Path $here '..\..\..')).Path
}

function Get-TrunkHeadSha([string]$TrunkRoot) {
  try {
    return (git -C $TrunkRoot rev-parse HEAD 2>$null).Trim()
  } catch {
    return ''
  }
}

function Get-IsoTimestampUtc {
  return (Get-Date).ToUniversalTime().ToString('o')
}

function Limit-Text([string]$Text, [int]$MaxChars = 20000) {
  if ($null -eq $Text) { return '' }
  if ($Text.Length -le $MaxChars) { return $Text }
  return $Text.Substring(0, $MaxChars) + "\n...<truncated>..."
}

function Read-BranchesConfig([string]$TrunkRoot) {
  $cfgPath = Join-Path $TrunkRoot 'config\branches.json'
  if (-not (Test-Path -LiteralPath $cfgPath)) {
    throw "Missing branches registry config: $cfgPath"
  }
  $raw = Get-Content -LiteralPath $cfgPath -Raw
  return ($raw | ConvertFrom-Json)
}

function Resolve-BranchConfig([string]$TrunkRoot, [string]$BranchName) {
  $cfg = Read-BranchesConfig -TrunkRoot $TrunkRoot
  if (-not $cfg.branches) { throw 'Invalid branches.json: missing branches object' }
  $branch = $cfg.branches.$BranchName
  if ($null -eq $branch) {
    throw "Branch not found in config/branches.json: $BranchName"
  }
  $entry = ''
  $type = ''
  $notes = ''
  if ($branch.PSObject.Properties.Name -contains 'entry') { $entry = [string]$branch.entry }
  if ($branch.PSObject.Properties.Name -contains 'type') { $type = [string]$branch.type }
  if ($branch.PSObject.Properties.Name -contains 'notes') { $notes = [string]$branch.notes }

  return [pscustomobject]@{
    name  = $BranchName
    entry = $entry
    type  = $type
    notes = $notes
  }
}

function Resolve-BranchEntry([string]$Entry) {
  if ([string]::IsNullOrWhiteSpace($Entry)) { return '' }
  return (Resolve-Path -LiteralPath $Entry).Path
}

function Get-EntrySha256([string]$EntryPath) {
  if ([string]::IsNullOrWhiteSpace($EntryPath)) { return '' }
  if (-not (Test-Path -LiteralPath $EntryPath)) { return '' }
  return (Get-FileHash -LiteralPath $EntryPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-KeyFilesHashes {
  param(
    [Parameter(Mandatory)] [string] $EntryPath,
    [int] $MaxFiles = 50,
    [long] $MaxTotalBytes = 10485760
  )

  $entryFull = (Resolve-Path -LiteralPath $EntryPath).Path
  $dir = Split-Path -Parent $entryFull

  $candidates = New-Object System.Collections.Generic.List[string]
  $candidates.Add($entryFull)

  foreach ($name in @('README.md','LICENSE','LICENSE.txt','manifest.json')) {
    $p = Join-Path $dir $name
    if (Test-Path -LiteralPath $p) { $candidates.Add((Resolve-Path -LiteralPath $p).Path) }
  }

  # bounded: only immediate folder, no recursion
  $ps1 = Get-ChildItem -LiteralPath $dir -File -Filter '*.ps1' -Force -ErrorAction SilentlyContinue |
    Where-Object {
      # Avoid following symlinks/reparse points into chaos
      -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    } |
    Select-Object -ExpandProperty FullName
  foreach ($p in $ps1) { $candidates.Add($p) }

  # Deduplicate deterministically
  $unique = $candidates.ToArray() | Sort-Object -Unique

  $results = New-Object System.Collections.Generic.List[object]
  $totalBytes = [long]0
  $count = 0

  foreach ($path in $unique) {
    if ($count -ge $MaxFiles) { break }
    if (-not (Test-Path -LiteralPath $path)) { continue }

    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (-not $item) { continue }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }

    $len = [long]0
    try { $len = [long]$item.Length } catch { $len = [long]0 }
    if (($totalBytes + $len) -gt $MaxTotalBytes) { break }

    $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    $results.Add([pscustomobject]@{ path = $path; sha256 = $sha })

    $totalBytes += $len
    $count++
  }

  return [pscustomobject]@{
    mode = 'adjacent_allowlist'
    limit = [pscustomobject]@{ max_files = $MaxFiles; max_total_bytes = $MaxTotalBytes }
    key_files = $results.ToArray()
    scanned = [pscustomobject]@{ files = $count; total_bytes = $totalBytes }
  }
}

function Find-BaselineScript([string]$TrunkRoot) {
  $candidates = @(
    $env:AUERNYX_BASELINE_SCRIPT,
    $env:BASELINE_SCRIPT
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path }
  }

  $sibling = Join-Path (Split-Path -Parent $TrunkRoot) '_baseline_repo_work\baseline.ps1'
  if (Test-Path -LiteralPath $sibling) { return (Resolve-Path -LiteralPath $sibling).Path }

  return ''
}

function Invoke-BaselinePhase {
  param(
    [Parameter(Mandatory)] [ValidateSet('pre','post','verify')] [string] $Mode,
    [Parameter(Mandatory)] [string] $TrunkRoot,
    [Parameter(Mandatory)] [string] $Label
  )

  $baselineScript = Find-BaselineScript -TrunkRoot $TrunkRoot
  if ([string]::IsNullOrWhiteSpace($baselineScript)) {
    return [pscustomobject]@{
      enabled   = $false
      script    = ''
      mode      = $Mode
      label     = $Label
      stdout    = ''
      bundleDir = ''
    }
  }

  $out = Join-Path $TrunkRoot ('artifacts\receipts\_baseline_{0}_{1}.out.txt' -f $Mode, ([Guid]::NewGuid().ToString('n')))
  $err = Join-Path $TrunkRoot ('artifacts\receipts\_baseline_{0}_{1}.err.txt' -f $Mode, ([Guid]::NewGuid().ToString('n')))
  New-Item -ItemType Directory -Path (Split-Path -Parent $out) -Force | Out-Null

  $p = Start-Process -FilePath 'powershell' -ArgumentList @(
      '-NoProfile','-ExecutionPolicy','Bypass',
      '-File', $baselineScript,
      $Mode,
      '-Label', $Label,
      '-LedgerRoot', $TrunkRoot
    ) -WorkingDirectory (Split-Path -Parent $baselineScript) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err

  $stdout = ''
  if (Test-Path -LiteralPath $out) { $stdout = Get-Content -LiteralPath $out -Raw }
  if (Test-Path -LiteralPath $err) {
    $stderr = Get-Content -LiteralPath $err -Raw
    if (-not [string]::IsNullOrWhiteSpace($stderr)) { $stdout = ($stdout + "\n" + $stderr) }
  }

  $bundle = ''
  $m = [regex]::Match($stdout, 'State capture bundle created:\s*(.+)$', [System.Text.RegularExpressions.RegexOptions]::Multiline)
  if ($m.Success) { $bundle = $m.Groups[1].Value.Trim() }

  return [pscustomobject]@{
    enabled   = $true
    script    = $baselineScript
    mode      = $Mode
    label     = $Label
    stdout    = (Limit-Text -Text $stdout)
    bundleDir = $bundle
    exitCode  = $p.ExitCode
  }
}

function Invoke-ExternalEntry {
  param(
    [Parameter(Mandatory)] [string] $EntryPath,
    [string] $Type = 'auto',
    [string[]] $Args = @()
  )

  $resolved = (Resolve-Path -LiteralPath $EntryPath).Path
  $workDir = Split-Path -Parent $resolved

  $ext = [IO.Path]::GetExtension($resolved).ToLowerInvariant()
  $kind = $Type
  if ($kind -eq 'auto' -or [string]::IsNullOrWhiteSpace($kind)) {
    if ($ext -eq '.ps1') { $kind = 'powershell' }
    elseif ($ext -in @('.cmd','.bat')) { $kind = 'cmd' }
    else { $kind = 'powershell' }
  }

  $stdoutPath = Join-Path $env:TEMP ('branchinvoke-{0}-out.txt' -f ([Guid]::NewGuid().ToString('n')))
  $stderrPath = Join-Path $env:TEMP ('branchinvoke-{0}-err.txt' -f ([Guid]::NewGuid().ToString('n')))

  if ($kind -eq 'cmd') {
    $argList = @('/c', $resolved) + $Args
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $argList -WorkingDirectory $workDir -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  } else {
    $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $resolved) + $Args
    $proc = Start-Process -FilePath 'powershell' -ArgumentList $argList -WorkingDirectory $workDir -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  }

  $outText = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
  $errText = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }

  return [pscustomobject]@{
    exitCode = $proc.ExitCode
    stdout   = (Limit-Text -Text $outText)
    stderr   = (Limit-Text -Text $errText)
    kind     = $kind
    workDir  = $workDir
  }
}

function Write-TrunkReceipt {
  param(
    [Parameter(Mandatory)] [string] $TrunkRoot,
    [Parameter(Mandatory)] [string] $BranchName,
    [Parameter(Mandatory)] [hashtable] $Receipt
  )

  $dir = Join-Path $TrunkRoot 'artifacts\receipts\branches'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null

  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $path = Join-Path $dir ("{0}-{1}.json" -f $stamp, $BranchName)

  $json = ($Receipt | ConvertTo-Json -Depth 12)
  Set-Content -LiteralPath $path -Value $json -Encoding UTF8

  $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath ($path + '.sha256') -Value ("{0}  {1}" -f $sha, (Split-Path -Leaf $path)) -Encoding ASCII

  return [pscustomobject]@{ receiptPath = $path; receiptSha256 = $sha }
}

function Invoke-BranchWithReceipt {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)] [string] $BranchName,
    [switch] $RunBaseline,
    [string[]] $Args = @()
  )

  $trunkRoot = Get-TrunkRoot
  $trunkHead = Get-TrunkHeadSha -TrunkRoot $trunkRoot

  $cfg = Resolve-BranchConfig -TrunkRoot $trunkRoot -BranchName $BranchName

  $entryRaw = $cfg.entry
  $entrySource = 'config'
  if ([string]::IsNullOrWhiteSpace($entryRaw)) {
    $envName = ('AUERNYX_BRANCH_ENTRY_{0}' -f $BranchName.ToUpperInvariant())
    $envVal = [Environment]::GetEnvironmentVariable($envName)
    if (-not [string]::IsNullOrWhiteSpace($envVal)) {
      $entryRaw = $envVal
      $entrySource = 'env'
    }
  }

  if ([string]::IsNullOrWhiteSpace($entryRaw)) {
    Write-Host ("{0}: not configured (branches.json entry empty and no AUERNYX_BRANCH_ENTRY_* override)" -f $BranchName)
    return [pscustomobject]@{ exitCode = 2; receiptPath = ''; trunkRoot = $trunkRoot }
  }

  $entryPath = Resolve-BranchEntry -Entry $entryRaw
  if ([string]::IsNullOrWhiteSpace($entryPath) -or (-not (Test-Path -LiteralPath $entryPath))) {
    Write-Host ("{0}: configured entry not found: {1}" -f $BranchName, $entryRaw)
    return [pscustomobject]@{ exitCode = 3; receiptPath = ''; trunkRoot = $trunkRoot }
  }

  $entrySha = Get-EntrySha256 -EntryPath $entryPath
  $keyFiles = Get-KeyFilesHashes -EntryPath $entryPath

  $baselineLabel = ("trunk_{0}_{1}" -f $BranchName, (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))

  $pre = $null
  $post = $null
  if ($RunBaseline) {
    $pre = Invoke-BaselinePhase -Mode 'pre' -TrunkRoot $trunkRoot -Label $baselineLabel
  }

  $exec = Invoke-ExternalEntry -EntryPath $entryPath -Type $cfg.type -Args $Args

  if ($RunBaseline) {
    $post = Invoke-BaselinePhase -Mode 'post' -TrunkRoot $trunkRoot -Label $baselineLabel
  }

  $receipt = [ordered]@{
    schema = 'trunk-branch-receipt.v1'
    timestamp = (Get-IsoTimestampUtc)
    trunk = [ordered]@{
      root    = $trunkRoot
      headSha = $trunkHead
    }
    branch = [ordered]@{
      name      = $BranchName
      entryPath = $entryPath
      entrySha256 = $entrySha
      type      = $cfg.type
      entrySource = $entrySource
    }
    execution = [ordered]@{
      kind     = $exec.kind
      workDir  = $exec.workDir
      exitCode = $exec.exitCode
      stdout   = $exec.stdout
      stderr   = $exec.stderr
    }
    baseline = [ordered]@{
      enabled = $RunBaseline.IsPresent
      label   = $baselineLabel
      pre     = if ($pre) { $pre } else { [pscustomobject]@{ enabled = $false } }
      post    = if ($post) { $post } else { [pscustomobject]@{ enabled = $false } }
    }
    key_files_mode = $keyFiles.mode
    key_files_limit = $keyFiles.limit
    key_files_scanned = $keyFiles.scanned
    key_files = $keyFiles.key_files
  }

  $written = Write-TrunkReceipt -TrunkRoot $trunkRoot -BranchName $BranchName -Receipt $receipt

  return [pscustomobject]@{
    exitCode    = $exec.exitCode
    receiptPath = $written.receiptPath
    receiptSha256 = $written.receiptSha256
    trunkRoot   = $trunkRoot
  }
}
