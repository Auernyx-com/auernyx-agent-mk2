Set-StrictMode -Version Latest

<#
ÆSIR GOVERNANCE CONTRACT INTERFACES (TRUNK)
- Signatures only. No side effects. No hidden behavior.
- These functions define the minimum orchestration + gating + recording surfaces.

Rule: if you implement behavior, it must live outside governance/contracts and be receipted.

Schema namespace guidance (when implementing record formats):
- aesir.governance.*
#>

#region Types (shape only)

function New-AesirPlan {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][ValidateSet("branch_execute","firewall_change","file_write","system_change")]
    [string]$ActionType,

    [Parameter(Mandatory)]
    [string]$Target,

    [Parameter()][ValidateSet("read_only","write_enabled")]
    [string]$Mode = "read_only",

    [Parameter()]
    [hashtable]$Parameters = @{},  # e.g. branch name, entry path, firewall profile

    [Parameter()]
    [string[]]$ExpectedReceipts = @("branch_receipt","baseline_pre","baseline_post","manifest_v1"),

    [Parameter()]
    [string]$Notes = ""
  )
  throw "Interface-only: New-AesirPlan has no implementation in TRUNK."
}

function Get-AesirPlanHash {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [object]$Plan
  )
  throw "Interface-only: Get-AesirPlanHash has no implementation in TRUNK."
}

#endregion Types

#region AUERNYX (orchestrator: plan-first + disclosure)

function Invoke-AuernyxPlanPreview {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [object]$Plan,

    [Parameter()]
    [ValidateSet("console","json","both")]
    [string]$Format = "both"
  )
  throw "Interface-only: Invoke-AuernyxPlanPreview has no implementation in TRUNK."
}

function Invoke-AuernyxBranch {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [string]$BranchId,                 # e.g. "skjoldr", "aesir"

    [Parameter(Mandatory)]
    [object]$Plan,                     # must be previewed to human if write_enabled or privileged

    [Parameter()]
    [ValidateSet("read_only","write_enabled")]
    [string]$Mode = "read_only",

    [Parameter()]
    [string]$ApprovalId = $null,        # required for write_enabled privileged actions

    [Parameter()]
    [string]$ReceiptTag = $null         # optional trace tag for receipt correlation
  )
  throw "Interface-only: Invoke-AuernyxBranch has no implementation in TRUNK."
}

#endregion AUERNYX

#region BASTION (gatekeeper: refuse unless conditions are met)

function Test-BastionGate {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [object]$Plan,

    [Parameter(Mandatory)]
    [ValidateSet("read_only","write_enabled")]
    [string]$Mode,

    [Parameter()]
    [string]$ApprovalId = $null,

    [Parameter()]
    [hashtable]$Context = @{}          # e.g. trunk HEAD, manifest path, baseline pre status
  )
  <#
  Returns a hashtable like:
  @{
    Allowed = $true/$false
    Reason  = "..."
    RequiredEvidence = @("approval","manifest","baseline_pre")
  }
  #>
  throw "Interface-only: Test-BastionGate has no implementation in TRUNK."
}

function Assert-BastionGate {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [hashtable]$GateResult
  )
  throw "Interface-only: Assert-BastionGate has no implementation in TRUNK."
}

#endregion BASTION

#region UEDEN (capture/write-side: append-only artifacts + receipts)

function New-UedenApprovalRecord {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [object]$Plan,

    [Parameter(Mandatory)]
    [string]$PlanHashSha256,

    [Parameter(Mandatory)]
    [string]$ActorId,                  # human identity label (non-sensitive)

    [Parameter()]
    [string]$Notes = ""
  )
  <#
  Returns an object describing the approval record to be written append-only.
  Writing must occur outside TRUNK contracts, but must be called via this interface.
  #>
  throw "Interface-only: New-UedenApprovalRecord has no implementation in TRUNK."
}

function Write-UedenAppendOnlyRecord {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [object]$Record,

    [Parameter(Mandatory)]
    [string]$RecordsRoot,              # where append-only records live

    [Parameter()]
    [string]$RecordId = $null          # optional explicit id
  )
  <#
  Returns:
  @{
    RecordPath = "..."
    RecordHashSha256 = "..."
    RecordId = "..."
  }
  #>
  throw "Interface-only: Write-UedenAppendOnlyRecord has no implementation in TRUNK."
}

function Write-UedenReceiptBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [object]$Plan,

    [Parameter()]
    [hashtable]$RunContext = @{},      # stdout/stderr, exit codes, resolved entry paths, etc.

    [Parameter(Mandatory)]
    [string]$ReceiptsRoot,             # receipt output directory

    [Parameter()]
    [string]$ReceiptTag = $null
  )
  <#
  Returns:
  @{
    ReceiptPath = "..."
    ReceiptHashSha256 = "..."
    Included = @("plan","baseline_pre","baseline_post","approval","outputs")
  }
  #>
  throw "Interface-only: Write-UedenReceiptBundle has no implementation in TRUNK."
}

#endregion UEDEN

#region MUEDEN (verify/recall-side: read-only integrity checks)

function Test-MuedenManifestSet {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [string]$ManifestPath,

    [Parameter(Mandatory)]
    [string]$RootPath                 # base path used to resolve manifest file entries
  )
  <#
  Returns:
  @{
    Valid = $true/$false
    Failures = @("missing_file: ...","hash_mismatch: ...")
    CheckedCount = <int>
  }
  #>
  throw "Interface-only: Test-MuedenManifestSet has no implementation in TRUNK."
}

function Resolve-MuedenRecord {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [string]$RecordId,

    [Parameter(Mandatory)]
    [string]$RecordsRoot
  )
  <#
  Returns:
  @{
    Found = $true/$false
    RecordPath = "..."
    RecordHashSha256 = "..."
    RecordObject = <object>
  }
  #>
  throw "Interface-only: Resolve-MuedenRecord has no implementation in TRUNK."
}

function Assert-MuedenIntegrity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]
    [hashtable]$IntegrityResult
  )
  throw "Interface-only: Assert-MuedenIntegrity has no implementation in TRUNK."
}

#endregion MUEDEN
