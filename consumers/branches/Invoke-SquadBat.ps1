[CmdletBinding()]
param(
  [string[]] $Args = @()
)

$ErrorActionPreference = 'Stop'

$lib = Join-Path $PSScriptRoot 'lib\BranchInvoke.ps1'
. $lib

$result = Invoke-BranchWithReceipt -BranchName 'squad-bat' -RunBaseline -Args $Args
exit $result.exitCode
