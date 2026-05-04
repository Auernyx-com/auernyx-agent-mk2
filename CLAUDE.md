# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run compile      # tsc compile to dist/
npm run typecheck    # type-check without emitting
npm run test         # compile tsconfig.test.json then run node --test dist/tests/*.test.js
npm run verify       # typecheck + compile + smoke-test CLI (memory + scan, no-daemon)
npm run daemon       # start headless daemon at http://127.0.0.1:43117
npm run cli -- <intent>  # run CLI directly, e.g. npm run cli -- scan .
```

**Compile is required before running CLI or daemon** — they run from `dist/`.

Mutating CLI operations require `AUERNYX_WRITE_ENABLED=1` and `--apply`:
```bash
AUERNYX_WRITE_ENABLED=1 npm run cli -- baseline pre --reason "..." --apply
```

## Architecture

Mk2 provides two **independent** agents that share a governance core but do not require each other:

1. **VS Code Extension** (`clients/vscode/extension.ts`) — thin VS Code wrapper; can optionally delegate to a running daemon, falls back to local execution
2. **Headless Agent** (`clients/cli/auernyx-daemon.ts` + `clients/cli/auernyx.ts`) — HTTP JSON API daemon + CLI + browser UI at `/ui`

### The single execution path

**All capability execution flows through `core/runLifecycle.ts`.** This is the governance invariant — nothing executes outside this path. The lifecycle enforces:

1. **Provenance check** (`core/provenance.ts`) — verifies `genesis.json` hash on every run; provenance failure activates Obsidian's Judgment, which blocks all non-read-only operations
2. **Legitimacy gate** (`core/legitimacyGate.ts`) — rejects illegitimate or ambiguous requests before planning
3. **Planner** (`core/planner.ts`) — produces a versioned, hash-identified `Plan` with typed `PlanStep[]` (READ_ONLY / CONTROLLED_WRITE / HIGH_RISK)
4. **Router** (`core/router.ts`) — maps intents to `CapabilityName` via text matching; executes only plan-scoped steps; enforces write gate, governance lock, and Obsidian's Judgment
5. **Capability** (`capabilities/*.ts`) — the actual work unit
6. **Receipt** (`core/receipts.ts`) — every run writes an audit trail under `.auernyx/receipts/<runId>/` with intake, plan, approvals, tool calls, governance decision, and final status

### Governance model

- **Policy** (`core/policy.ts`) defines all `CapabilityName` values with `readOnly` and `tier` (0=safe, 1=controlled, 2=high-risk). All capabilities require an approval by policy — no tier bypasses the approval gate.
- **Allowlist** (`config/allowlist.json`) controls which capabilities are enabled at runtime; `createPolicy(repoRoot)` loads it.
- **Governance lock** (`core/governanceLock.ts`) — `logs/governance.lock.json`; while locked, only `memoryCheck`, `governanceSelfTest`, and `governanceUnlock` run.
- **Guarded filesystem** (`core/guardedFs.ts`) — all capability writes must go through `guardedWriteFile` / `guardedMkdir`, which block writes to protected paths (`core/kintsugi/protectedPaths.ts`).
- **Protected paths** include anything under `.auernyx/kintsugi/` (ledger records, policy history, active policy). These are write-once audit paths.
- **Step-scoped approvals** — each `PlanStep` requires a `StepApproval` with matching `stepId`. A single approval does not cover multiple steps.

### Key config surface

`config/auernyx.config.json` controls daemon bind address/port/secret, rate limits, `writeEnabled`, `receiptsEnabled`, `governance.approverIdentity`, `governance.protectedPaths`, rollback policy, and the Skjoldr firewall addon. `AUERNYX_WRITE_ENABLED=1` env overrides `writeEnabled`.

### Branch model

- `main` — trunk; governance law is tagged on trunk
- `staging/platform-canary` — canary; promotion into trunk is explicit

## Key invariants (do not break)

- `runLifecycle` is the only path to capability execution — `router.run()` throws if `ctx.execution` is absent
- `.auernyx/kintsugi/` paths are immutable audit storage — never write there except through Kintsugi's own append methods
- Every run (success or refusal) must finalize a receipt
- `AUERNYX_WRITE_ENABLED` must be set externally; the agent does not self-enable writes
