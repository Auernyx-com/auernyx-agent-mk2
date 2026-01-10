[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseApprovedVerbs', '', Justification = 'Legacy QA entrypoint name; behavior is internal and read-only.')]
[CmdletBinding()]
param(
  [switch] $ScanBranches,

  # Retired token to forbid in active areas.
  [string] $Token = 'citadel'
)

$ErrorActionPreference = 'Stop'

function Get-TrunkRoot {
  $here = (Resolve-Path -LiteralPath $PSScriptRoot).Path
  return (Resolve-Path -LiteralPath (Join-Path $here '..\..')).Path
}

function Get-ScanFiles([string]$Root) {
  $skipDirs = @('.git','node_modules','dist','artifacts','logs')
  $allowedExt = @('.ps1','.psm1','.psd1','.cmd','.bat','.ts','.js','.json','.md','.txt','.toml','.yml','.yaml')

  return Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
    Where-Object {
      if ($_.FullName -eq $PSCommandPath) { return $false }
      $extOk = $allowedExt -contains $_.Extension.ToLowerInvariant()
      if (-not $extOk) { return $false }

      $rel = $_.FullName.Substring($Root.Length).TrimStart('\','/')
      foreach ($d in $skipDirs) {
        if ($rel -like "$d\*") { return $false }
      }
      return $true
    }
}

function Find-RetiredBrandHits([string]$Root, [string]$Label) {
  Write-Host ("Scanning retired-brand token ({0}) in {1}: {2}" -f $Token, $Label, $Root)

  $allowRelPrefixes = @(
    'codex\archives\citadel-retired\',
    'archives\citadel-retired\'
  )

  $hits = New-Object System.Collections.Generic.List[object]

  foreach ($f in (Get-ScanFiles -Root $Root)) {
    $rel = $f.FullName.Substring($Root.Length).TrimStart('\','/')
    $relNorm = $rel -replace '/','\\'
    $relLower = $relNorm.ToLowerInvariant()

    $allowed = $false
    foreach ($pfx in $allowRelPrefixes) {
      if ($relLower.StartsWith($pfx)) { $allowed = $true; break }
    }
    if ($allowed) { continue }

    $m = Select-String -LiteralPath $f.FullName -Pattern $Token -SimpleMatch -AllMatches -ErrorAction SilentlyContinue
    if ($m) {
      foreach ($r in $m) {
        $hits.Add([pscustomobject]@{ File = $f.FullName; Line = $r.LineNumber; Text = $r.Line.Trim() })
      }
    }
  }

  return $hits.ToArray()
}

function Read-BranchesConfig([string]$TrunkRoot) {
  $cfgPath = Join-Path $TrunkRoot 'config\branches.json'
  if (-not (Test-Path -LiteralPath $cfgPath)) { return $null }
  return ((Get-Content -LiteralPath $cfgPath -Raw) | ConvertFrom-Json)
}

$trunkRoot = Get-TrunkRoot

$allHits = New-Object System.Collections.Generic.List[object]
$trunkHits = Find-RetiredBrandHits -Root $trunkRoot -Label 'TRUNK'
if ($trunkHits) { $allHits.AddRange($trunkHits) }

if ($ScanBranches) {
  $cfg = Read-BranchesConfig -TrunkRoot $trunkRoot
  if ($cfg -and $cfg.branches) {
    foreach ($prop in $cfg.branches.PSObject.Properties) {
      $bName = $prop.Name
      $b = $prop.Value
      $entry = if ($b.PSObject.Properties.Name -contains 'entry') { [string]$b.entry } else { '' }
      if ([string]::IsNullOrWhiteSpace($entry)) { continue }
      if (-not (Test-Path -LiteralPath $entry)) { continue }
      $entryPath = (Resolve-Path -LiteralPath $entry).Path
      $root = Split-Path -Parent $entryPath
      $branchHits = Find-RetiredBrandHits -Root $root -Label ("BRANCH:{0}" -f $bName)
      if ($branchHits) { $allHits.AddRange($branchHits) }
    }
  }
}

if ($allHits.Count -gt 0) {
  Write-Host ''
  Write-Host ('RETIRED BRAND HITS: {0}' -f $allHits.Count)
  foreach ($h in ($allHits | Sort-Object File, Line)) {
    Write-Host ("{0}:{1}: {2}" -f $h.File, $h.Line, $h.Text)
  }
  exit 1
}

Write-Host 'OK: retired brand token not found outside allowlist.'
exit 0
