# Æurnyx Agent Mk2 — Summary

## What It Is

Æurnyx Agent Mk2 is a sovereign, self-contained AI governance and orchestration layer. It governs capability execution through a universal policy pipeline — any program or system attaches to Mk2 as a branch. The trunk enforces governance. The branch does the work.

Mk2 does not depend on any external cloud provider, execution service, or third-party platform. It is self-contained by design.

## Yggdrasil Architecture

```
Root     → The Architect's vision (immutable)
Trunk    → Æurnyx Mk2 (this repo — governance law lives here)
Branches → External programs and systems (attach via capability sockets)
Leaf     → Execution output
Sap      → Mnēma (persistent memory layer)
```

Mk2 is the trunk. It does not execute on behalf of branches — it governs them. A branch that wants governed execution registers a capability socket in `capabilities/`. Until a branch is connected, that socket fails closed with `BRANCH_NOT_CONNECTED`.

## Why Mk2, Not Mk1

Mk1 was VS Code–bound. It executed tools directly inside the editor with no policy layer, no audit trail, and no governance separation.

Mk2 crossed three irreversible lines:

| Mk1 | Mk2 |
|-----|-----|
| The agent runs tools | The agent authorizes tools |
| The agent has power | The agent enforces limits |
| Editor extension | Control plane |

That is not an iteration. That is a species change.

## Core Principles

1. **Reasoning is not action.** Æurnyx plans and governs. Capabilities act.
2. **Policy-first execution.** No action without explicit allowlist entry, plan, evidence, and approval.
3. **Fail-closed always.** Ambiguous state gates closed. Never default open.
4. **Receipt-backed operations.** Every run — success or refusal — produces a tamper-evident audit trail.
5. **Sovereign by design.** No external dependencies on execution. The trunk governs itself.

## Architecture

### Single Execution Path

All capability execution flows through `core/runLifecycle.ts`. This is the governance invariant — nothing executes outside this path.

```
Intent
  → Legitimacy Gate       (core/legitimacyGate.ts)     — blocks illegitimate requests
  → Planner               (core/planner.ts)             — produces versioned, hash-identified Plan
  → Router                (core/router.ts)              — maps intent to capability, enforces gates
  → Capability            (capabilities/*.ts)           — the work unit
  → Receipt               (core/receipts.ts)            — audit trail written for every run
```

### Governance Model

- **Policy** (`core/policy.ts`) — defines all capabilities with `readOnly` and `tier` (0=read-only, 1=controlled write, 2=high-risk)
- **Allowlist** (`config/allowlist.json`) — deny by default; only listed capabilities run
- **Governance lock** (`core/governanceLock.ts`) — locks system on integrity failure; only three capabilities run while locked
- **Provenance** (`core/provenance.ts`) — verifies genesis.json hash on every run; failure activates Obsidian's Judgment
- **Guarded filesystem** (`core/guardedFs.ts`) — all capability writes go through path protection
- **Kintsugi ledger** (`core/kintsugi/`) — hash-chained audit record; failures are visible, repairs are permanent

### Capability Tiers

| Tier | Risk | Write Gate | Examples |
|------|------|-----------|---------|
| 0 | Read-only | No | scanRepo, memoryCheck, governanceSelfTest |
| 1 | Controlled write | Yes | baselinePre, baselinePost, proposeFixes, searchDocApply |
| 2 | High-risk | Yes + elevated approval | rollbackKnownGood, docker, fenerisPrep, skjoldrFirewall ops |

### Named System Personas

| Name | Role |
|------|------|
| Auernyx | Governance orchestrator — the trunk |
| Bastion | Defense and integrity layer |
| Mnēma | Persistent memory (Sap layer) |
| Obsidian | Provenance judgment — activates on genesis failure |
| Ghost | Dual-witness verifier — pure observer, no side effects |
| Feneris | Watchdog — log watching, compromise detection, code flagging (branch declared, not yet connected) |
| Mondag | Pending |
| Smalls | Pending |
| Sovereignty | Pending |

### Branch Attachment Points

Mk2 is designed to govern any program. Attachment points are declared as capabilities in `capabilities/`. An unconnected socket throws `BRANCH_NOT_CONNECTED` rather than silently succeeding.

Currently declared but unconnected:
- `docker` — Docker environment branch
- `fenerisPrep` — Feneris watchdog branch

## Clients

Two independent clients share the governance core and do not require each other:

- **VS Code Extension** (`clients/vscode/extension.ts`) — thin wrapper; delegates to daemon or falls back to local execution
- **Headless Daemon + CLI** (`clients/cli/`) — HTTP JSON API at `127.0.0.1:43117` + CLI + browser UI at `/ui`

## Canonical Vocabulary

| Term | Meaning |
|------|---------|
| `WITHIN_TOLERANCE` | Normal operation — system functioning within known parameters |
| `CONTROLLED` | Elevated authorization mode — deliberately entered, human-approved, receipted |
| `FAILED_CLOSED` | Automatic response to integrity violation — not configurable, not reversible without visible repair |
| `CONTROLLED` (action risk) | Past action was low-risk, managed within controlled parameters |
| `ELEVATED` (action risk) | Past action carried elevated risk — a loosening or policy change |
| `CRITICAL` (action risk) | Past action was a critical governance event |

## Non-Negotiable Invariants

1. `runLifecycle` is the only path to capability execution
2. `.auernyx/kintsugi/` paths are immutable audit storage — never write there except through Kintsugi's own append methods
3. Every run (success or refusal) must finalize a receipt
4. `AUERNYX_WRITE_ENABLED` must be set externally — the agent does not self-enable writes
5. Fail-closed always — ambiguous state is not open state
