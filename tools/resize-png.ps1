# Resizes a PNG to multiple square sizes using System.Drawing (Windows PowerShell).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\resize-png.ps1 -InPng <path> -OutDir <dir> -Sizes 16,24,32

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InPng,

  [Parameter(Mandatory = $true)]
  [string]$OutDir,

  [Parameter(Mandatory = $true)]
  [string[]]$Sizes
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Drawing
}
catch {
  throw "System.Drawing is unavailable in this PowerShell environment. Try Windows PowerShell 5.1 (powershell.exe) or regenerate the icon on a Windows machine that supports System.Drawing. ($($_.Exception.Message))"
}

$inPath = (Resolve-Path -LiteralPath $InPng).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$parsedSizes = @()
foreach ($s in $Sizes) {
  foreach ($part in ($s -split ',')) {
    $part = $part.Trim()
    if ($part.Length -eq 0) { continue }
    $n = 0
    if (-not [int]::TryParse($part, [ref]$n)) {
      throw "Invalid size: $part"
    }
    $parsedSizes += $n
  }
}

if ($parsedSizes.Count -eq 0) {
  throw 'No sizes provided'
}

$img = [System.Drawing.Image]::FromFile($inPath)

try {
  foreach ($s in $parsedSizes) {
    if ($s -le 0) { continue }

    $bmp = New-Object System.Drawing.Bitmap $s, $s
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($img, 0, 0, $s, $s)
      }
      finally {
        $g.Dispose()
      }

      $outFile = Join-Path $OutDir ("${s}.png")
      $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
      $bmp.Dispose()
    }
  }
}
finally {
  $img.Dispose()
}
