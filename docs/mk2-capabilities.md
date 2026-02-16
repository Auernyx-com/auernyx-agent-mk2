# Auernyx Agent Mk2 — Capabilities & Usage

This document is a human-readable overview of what Mk2 can do right now.

## What Mk2 Is

Mk2 is a deterministic, policy-gated agent core with:

- A small always-on daemon (HTTP JSON API)
- A router that maps *intent text* → *capability*
- A policy layer (allowlist)
- An append-only ledger (hash-chained NDJSON)
- Optional clients (CLI + VS Code) that call the daemon first and fall back to local execution

No LLM is required.

Governance/audit artifacts are stored repo-locally under:
- `.auernyx/kintsugi/` (Kintsugi ledger + policy history + Known Good Snapshots)

Important: `.auernyx/kintsugi/` is a protected path. Governed mutations must refuse writes into Kintsugi audit/policy/ledger paths.

### Governance: Alteration Program for Mk2 Itself

- Changes to Mk2 itself (including capabilities and their configuration) are governed by the alteration program.
- Every non-Dependabot PR must include **exactly one** intent JSON file under `governance/alteration-program/intent/` with filename `<intentId>.json` where `<intentId>` has the form `13digits-8hex` and matches the `intentId` field inside the file.
- You can generate an intent file for a commit with: `python3 tools/intent_generator.py --commit <sha>`, then add the resulting file to `governance/alteration-program/intent/` as part of your PR.

---

## Capability List (Current)

### 1) scanRepo
- Purpose: Count files under a root directory.
- Notes: Skips `node_modules`, `dist`, `logs`, and `artifacts`.
- Safety: `targetDir` is restricted. By default scanning is limited to the repo root; extend via `paths.scanAllowedRoots` in `config/auernyx.config.json`.
- Output (example):
  - `{ "root": "C:\\path", "fileCount": 1234 }`

### 2) fenerisPrep
- Purpose: Create a Windows scaffold folder and `init.ps1` skeleton.
- Writes:
  - `feneris-windows/init.ps1`

### 3) baselinePre
- Purpose: Record a “Known Good Snapshot” (KGS) of key config files.
- Writes:
  - `artifacts/known_good/entries/*.kgs.json`
  - `artifacts/known_good/snapshots/<KGS_ID>/...`
- Also writes (Kintsugi):
  - `.auernyx/kintsugi/policy/history/*.policy.json`
  - `.auernyx/kintsugi/known_good/entries/*.kgs.json`
- Notes: Intended to be run before mutating operations as an easy rollback anchor.

### 4) baselinePost
- Purpose: Verify ledger integrity (hash-chain validation).
- Reads:
  - `logs/ledger.ndjson`

### 5) docker (placeholder)
- Purpose: Reserved for Docker operations.
- Current behavior: returns `{ "ok": true }`.

### 6) memoryCheck
- Purpose: Quick health/integrity summary.
- Includes:
  - Mk2 ledger integrity check summary (`logs/ledger.ndjson`).
  - Kintsugi integrity + active policy summary (`.auernyx/kintsugi/*`).
  - Count of recorded Known Good Snapshots (both).

### 7) proposeFixes
- Purpose: Suggest (and optionally apply) Kintsugi policy changes.
- Writes (only if `apply: true`):
  - `.auernyx/kintsugi/policy/history/*.policy.json` (append-only)
  - `.auernyx/kintsugi/policy/active.policy.json` (atomic replace)
- Notes:
  - “Loosening” policy changes are treated as CONTROLLED and require typed APPLY (`approval.confirm=APPLY`).

### 8) governanceSelfTest
- Purpose: Run a governance/integrity self-test and record the result.
- Writes:
  - `logs/governance.lock.json`

### 9) governanceUnlock
- Purpose: Clear governance lock only if integrity checks pass.
- Writes:
  - `logs/governance.lock.json`

### 10) rollbackKnownGood
- Purpose: List or restore a Kintsugi Known Good Snapshot (policy rollback).
- Reads/Writes:
  - Reads `.auernyx/kintsugi/known_good/entries/*.kgs.json`
  - Reads `.auernyx/kintsugi/policy/history/*.policy.json`
  - Writes `.auernyx/kintsugi/policy/history/*.policy.json` + activates `active.policy.json`
- Notes:
  - Rollback is policy-driven and refuses if the KGS `ledger_head_hash` is not present in the current ledger chain.
  - `rollbackRiskClass=CONTROLLED` requires typed APPLY (`approval.confirm=APPLY`).

### 11) Skjoldr firewall suite
- `skjoldrFirewallStatus` — status/inspection
- `skjoldrFirewallApplyProfile` — apply a named profile (mutating)
- `skjoldrFirewallApplyRulesetFile` — apply a ruleset file (mutating)
- `skjoldrFirewallExportBaseline` — export baseline
- `skjoldrFirewallRestoreBaseline` — restore baseline
- `skjoldrFirewallAdviseInboundRuleSets` — analyze inbound rules and provide recommendations (read-only)
- `analyzeDependency` — dependency risk analysis scaffold (read-only)


---



## Intent Routing (What Text Triggers What)

Routing is simple and deterministic:

- Starts with `scan` → `scanRepo`
- Contains `feneris` → `fenerisPrep`
- Contains `baseline pre` → `baselinePre`
- Contains `baseline post` → `baselinePost`
- Contains `memory` → `memoryCheck`
- Contains `propose fixes` / starts with `fix` → `proposeFixes`
- Contains `governance` + `self-test` → `governanceSelfTest`
- Contains `governance` + `unlock` → `governanceUnlock`
- Contains `rollback` / `known good` / `kgs` → `rollbackKnownGood`
- Contains `skjoldr` or `firewall` → routes to the matching Skjoldr capability based on keywords:
  - `status` → `skjoldrFirewallStatus`
  - `export baseline` → `skjoldrFirewallExportBaseline`
  - `restore baseline` → `skjoldrFirewallRestoreBaseline`
  - `apply profile` → `skjoldrFirewallApplyProfile`
  - `apply ruleset/file` → `skjoldrFirewallApplyRulesetFile`
  - `advise/advice/recommend` + `inbound/ib` → `skjoldrFirewallAdviseInboundRuleSets`
- Contains both `analyze` and `dependency` → `analyzeDependency`
- Contains `docker` → `docker`

If nothing matches, the intent is “unroutable”.

---

## Running Mk2 Like a Real Agent

### Double-click launchers (Windows)

From the repo root:

- `Start-Mk2.cmd` — compiles then starts the daemon
- `Auernyx.cmd` — runs the CLI (daemon-first, local fallback)

### Option A — Always-on daemon (recommended pattern)

1) Compile:
- `npm run compile`

2) Start daemon:
- `node dist/core/server.js`

By default it binds to `127.0.0.1:43117`.

Environment overrides:
- `AUERNYX_HOST` (default: `127.0.0.1`)
- `AUERNYX_PORT` (default: `43117`)
- `AUERNYX_SECRET` (default: empty/disabled)
- `AUERNYX_MAX_BODY_BYTES` (default: `65536`)
- `AUERNYX_RATE_WINDOW_MS` (default: `10000`)
- `AUERNYX_RATE_MAX` (default: `30`)

### Option B — CLI (daemon-first, local fallback)

After compile:

- Run a scan of the current repo root:
  - `node dist/clients/cli/auernyx.js scan`

- Run a scan of a specific directory:
  - `node dist/clients/cli/auernyx.js scan C:\\somepath`

- Trigger feneris prep:
  - `node dist/clients/cli/auernyx.js feneris`

The CLI will:
1) Try the daemon (`POST /run`)
2) If the daemon isn’t reachable, run locally in-process

---

## Smoke Tests (Safe / Read-Only First)

These are copy/paste examples that exercise the daemon end-to-end.

Prereqs:
- `npm run compile`
- Start daemon (from repo root):
  - `node dist/core/server.js`
  - or `node dist/clients/cli/auernyx-daemon.js`

### Kintsugi quickstart (recommended flow)

1) Take a Known Good Snapshot (also snapshots Kintsugi policy):
- `baseline pre`

2) Inspect Kintsugi status:
- `memory`
- Or `GET /config` (includes Kintsugi policy hash + integrity summary)

3) Propose policy changes:
- `propose fixes`

4) Apply a policy change (CONTROLLED changes require typed APPLY):
- `propose fixes apply <SUGGESTION_ID>`

5) If needed, rollback policy to a KGS:
- `rollback list`
- `rollback restore <KGS_ID>`

On disk, Kintsugi artifacts live under:
- `.auernyx/kintsugi/policy/active.policy.json`
- `.auernyx/kintsugi/policy/history/*.policy.json`
- `.auernyx/kintsugi/ledger/records/*.json`
- `.auernyx/kintsugi/known_good/entries/*.kgs.json`

### PowerShell: helper to build an approval payload

```powershell
$approval = @{
  approvedBy = "human"
  at         = (Get-Date).ToString("o")
  reason     = "smoke test"
}
```

### 1) Memory / integrity check

```powershell
$body = @{ intent = "memory"; approval = $approval } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

### 2) Record a Known Good Snapshot (baseline pre)

```powershell
$body = @{ intent = "baseline pre"; approval = $approval } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

### 3) List Known Good Snapshots (rollback list)

```powershell
$body = @{ intent = "rollback known good"; input = @{ action = "list"; limit = 10 }; approval = $approval } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

### 4) Propose fixes (read-only)

```powershell
$body = @{ intent = "propose fixes"; approval = $approval } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

### 4b) Apply a Kintsugi policy suggestion (mutating)

This is CONTROLLED if the change loosens governance and requires `approval.confirm = "APPLY"`.

```powershell
$approval2 = $approval.Clone()
$approval2.confirm = "APPLY"

$body = @{
  intent    = "propose fixes apply enable-riskTolerance-controlled"
  input     = @{ apply = $true; suggestionId = "enable-riskTolerance-controlled" }
  approval  = $approval2
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

### 5) Skjoldr daemon JSON examples (mutating)

These require the Skjoldr add-on to be enabled/configured and JSON mode enabled.

Apply a profile:

```powershell
$body = @{
  intent    = "skjoldr apply profile"
  input     = @{ profile = "<PROFILE_NAME>" }
  approval  = $approval
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

Apply a ruleset file:

```powershell
$body = @{
  intent    = "skjoldr apply ruleset file"
  input     = @{ rulesetPath = "C:\\path\\to\\ruleset.json" }
  approval  = $approval
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

Restore a baseline:

```powershell
$body = @{
  intent    = "skjoldr restore baseline"
  input     = @{
    baselineSnapshotPath = "C:\\path\\to\\baseline.snapshot"
    baselineSnapshotHash = "<SHA256_HEX>"
  }
  approval  = $approval
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:43117/run" -ContentType "application/json" -Body $body
```

### CLI equivalents

The CLI prompts for approval interactively (reason text), so these are safe quick checks:

- `node dist/clients/cli/auernyx.js memory`
- `node dist/clients/cli/auernyx.js baseline pre`
- `node dist/clients/cli/auernyx.js rollback known good`

More structured CLI inputs:

- List KGS entries (limit 10):
  - `node dist/clients/cli/auernyx.js rollback list --limit 10`
- Restore KGS:
  - `node dist/clients/cli/auernyx.js rollback restore <KGS_ID>`
- Propose fixes (read-only):
  - `node dist/clients/cli/auernyx.js propose`
- Apply a suggested fix (mutating):
  - `node dist/clients/cli/auernyx.js propose apply enable-riskTolerance-controlled`
  - Note: CONTROLLED loosening changes require typing `APPLY` when prompted.
- Governance:
  - `node dist/clients/cli/auernyx.js governance self-test`
  - `node dist/clients/cli/auernyx.js governance unlock`
- Skjoldr:
  - `node dist/clients/cli/auernyx.js skjoldr status`
  - `node dist/clients/cli/auernyx.js skjoldr export-baseline`
  - `node dist/clients/cli/auernyx.js skjoldr restore-baseline --snapshot <FILE> --hash <SHA256>`
  - `node dist/clients/cli/auernyx.js skjoldr apply-profile <NAME>`
  - `node dist/clients/cli/auernyx.js skjoldr apply-ruleset <FILE>`
  - `node dist/clients/cli/auernyx.js skjoldr advise inbound rules`

### Option C — VS Code extension

The VS Code extension acts as a thin wrapper:

- It attempts to call the daemon first.
- If the daemon isn’t running, it falls back to local execution.

Commands:
- `Ask Auernyx`
- `Scan Repo (Auernyx)`
- `Prepare Feneris Port`

---

## Daemon HTTP API

### GET /health
Returns:
- `{ "ok": true }`

### GET /ledger
Purpose:
- Read-only inspection of the append-only hash-chained ledger (for future dev inspection).

Query params:
- `tail` (optional, default `50`, max `1000`) — how many entries to return from the end.

Headers:
- `x-auernyx-secret: <shared secret>` (required if a daemon secret is configured)

Returns:
- `{ "ok": true, "count": <n>, "entries": [ ... ] }`

Notes:
- Values under keys that include `secret` (and common auth header keys) are returned as `[REDACTED]`.

### GET /config
Purpose:
- Read-only inspection of the daemon’s *effective* configuration (for future dev inspection).

Headers:
- `x-auernyx-secret: <shared secret>` (required if a daemon secret is configured)

Returns:
- `{ "ok": true, "result": { "repoRoot": "...", "daemon": { ... }, "paths": { ... }, "allowlist": { ... } } }`

Notes:
- The shared secret value is never returned (only `secretEnabled: true|false`).

### POST /run
Request body:
- `{ "intent": "<string>", "input": <optional>, "approval": <required> }`

Headers:
- `x-auernyx-secret: <shared secret>` (required if a daemon secret is configured)

Response body (success):
- `{ "ok": true, "capability": "scanRepo", "result": { ... } }`

Response body (failure):
- `{ "ok": false, "error": "..." }`

Notes:
- Unroutable intents return an error.
- Blocked capabilities return an error (policy enforcement).
- Missing approval returns `approval_required`.
- Rate limiting may return `rate_limited`.
- Oversized requests may return `payload_too_large`.

---

## Governance Posture: Daemon-First with Degraded Local Fallback

Mk2 operates in **daemon-first** mode when the Auernyx core daemon is reachable. In this mode, the daemon is the preferred execution authority for capabilities.

If the daemon is not reachable, Mk2 may enter **degraded local fallback** mode from the VS Code client. In degraded mode:

- Execution still flows through the same router and allowlist policy.
- All actions must write to the ledger with explicit provenance tagging (e.g., `via: local` vs `via: daemon`).
- Degraded mode is not assumed equivalent to daemon authority; it exists for resilience during development and constrained operation.

Future hardening may introduce **capability tiers**:
- **Tier 0**: allowed in degraded fallback (read-only/status/reporting)
- **Tier 1+**: daemon-only (and optionally approval-gated)

If approval-gating is introduced, it must be enforced identically in both daemon and fallback paths. If parity cannot be guaranteed, degraded fallback will be restricted to Tier 0.

Note: Mk2 currently enforces blanket human approval for all capabilities (no exceptions).

---

## Policy / Allowlist

The allowlist lives at:
- `config/allowlist.json`

If a capability is not allowlisted, the router will refuse to run it.

---

## Human-in-the-Loop Approval (No Exceptions)

Mk2 enforces a strict rule:

- No capability executes unless a human explicitly approves it.

How this is enforced:

- The core router refuses to run mutating capabilities without an `approval` object.
- The daemon returns `approval_required` if approval is missing.
- The CLI and VS Code clients prompt the user for approval (and a required reason) and then re-run with the approval attached.

Notes:

- This includes Tier 0 / read-only actions like `scanRepo`.
- Ledger writes are automatic evidence (they happen to record approvals and actions); approval gating is applied to capability side-effects.

Current tiers (policy metadata):

- Tier 0 (read-only): `scanRepo`, `analyzeDependency`
- Tier 1 (mutating, approval required): `fenerisPrep`, `baselinePre`, `baselinePost`
- Tier 2 (high-risk, approval required): `docker`

---

## Ledger (Evidence Trail)

Mk2 writes an append-only ledger at:
- `logs/ledger.ndjson`

Each entry includes:
- `prevHash` and `hash` to create a simple integrity chain.

For inspection without opening files, the daemon exposes `GET /ledger`.

---

## Build Artifacts: What `npm run compile` Produces

The TypeScript build process (`npm run compile`) produces compiled JavaScript artifacts in the `dist/` directory.

### Artifact Types
- **`.js`** — Executable JavaScript (runtime code)
- **`.d.ts`** — TypeScript type declarations
- **`.js.map`** — Source maps for debugging

### Output Location
All compiled artifacts are emitted to:
- `dist/`

### Key Entry Points
- `dist/clients/vscode/extension.js` — VS Code extension
- `dist/clients/cli/auernyx.js` — CLI client  
- `dist/core/server.js` — Daemon server

**Note**: This describes the **build output** (compiled artifacts). For information about **runtime execution modes** (daemon vs local), see the "Governance Posture" section above.
