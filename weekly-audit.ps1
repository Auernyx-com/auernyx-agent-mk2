# PowerShell Weekly Audit Script (root-level wrapper)
#
# This script is a thin convenience wrapper that delegates to the canonical
# implementation in tools/weekly-audit.ps1, which contains the actual audit logic.

$toolsScript = Join-Path -Path $PSScriptRoot -ChildPath 'tools/weekly-audit.ps1'

if (-not (Test-Path -LiteralPath $toolsScript)) {
    throw "Expected tools script not found at '$toolsScript'. Ensure tools/weekly-audit.ps1 exists."
}

# Delegate to the tools script, forwarding all arguments
& $toolsScript @args