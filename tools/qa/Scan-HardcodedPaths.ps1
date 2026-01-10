[CmdletBinding()]
param(
  [switch] $ScanBranches,
  [string[]] $Patterns = @(
    'C:\Æsir',
    '\Æsir\',
    'AEsir\RUNTIME',
    'C:\AEsir'
  )
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

function Find-RootScanHits([string]$Root, [string]$Label) {
  Write-Host ("Scanning {0}: {1}" -f $Label, $Root)
  $hits = New-Object System.Collections.Generic.List[object]

  foreach ($f in (Get-ScanFiles -Root $Root)) {
    foreach ($p in $Patterns) {
      $m = Select-String -LiteralPath $f.FullName -Pattern $p -SimpleMatch -AllMatches -ErrorAction SilentlyContinue
      if ($m) {
        foreach ($r in $m) {
          $hits.Add([pscustomobject]@{ File = $f.FullName; Line = $r.LineNumber; Text = $r.Line.Trim() })
        }
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
$trunkHits = Find-RootScanHits -Root $trunkRoot -Label 'TRUNK'
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
      $branchHits = Find-RootScanHits -Root $root -Label ("BRANCH:{0}" -f $bName)
      if ($branchHits) { $allHits.AddRange($branchHits) }
    }
  }
}

if ($allHits.Count -gt 0) {
  Write-Host ''
  Write-Host ('HARD-CODED PATH HITS: {0}' -f $allHits.Count)
  foreach ($h in ($allHits | Sort-Object File, Line)) {
    Write-Host ("{0}:{1}: {2}" -f $h.File, $h.Line, $h.Text)
  }
  exit 1
}

# Retired-brand scan lives in its own QA script (hard fail)
$brandScript = Join-Path $PSScriptRoot 'Scan-RetiredBrand.ps1'
if (Test-Path -LiteralPath $brandScript) {
  & $brandScript -ScanBranches:$ScanBranches
} else {
  Write-Warning "WARN: missing retired-brand scanner: $brandScript"
}

Write-Host 'OK: no hardcoded cross-branch paths found.'
exit 0
