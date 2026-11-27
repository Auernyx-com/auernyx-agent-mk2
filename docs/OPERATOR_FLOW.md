# Auernyx Mk2 — Operator Flow (Quick Reference)

This is a personal “what now?” map. If you can’t answer **Where am I? / What can I do? / Why is it saying no?** in under 5 seconds, use this.

## 0) Where am I?

- Repo root: the folder that contains `config/auernyx.config.json`
- State files (runtime): `.auernyx/` (gitignored)
- Receipts (audit trail per run): `.auernyx/receipts/<RUN_ID>/`
- Provenance state:
  - Genesis: `.auernyx/provenance/genesis.json`
  - Judgment: `.auernyx/provenance/judgment.json`

## 1) One-verb rails (always)

- Step 1: **Intake** (intent)
- Step 2: **Check** (governance + provenance)
- Step 3: **Receipt** (what happened + hashes)

In VS Code, the `Auernyx` Output channel prints those three steps.

## 2) The flow chart

```mermaid
flowchart TD
  A[Start: You have an intent] --> B{Where are you running?}

  B -->|VS Code| V[Command Palette]
  B -->|CLI| C[Terminal]

  %% VS Code path
  V --> V1[Run: Ask Auernyx / Scan Repo / Feneris Prep]
  V1 --> V2{Result}
  V2 -->|OK| VOK[Done]
  V2 -->|REFUSED| VR[See REFUSED dialog]
  VR --> VR1[Read: reason + next valid state]
  VR1 --> VR2{Next}
  VR2 -->|Run Scan (Monitor)| VSCAN[Scan Repo]
  VR2 -->|Reveal Receipt| VREC[Open receipt folder]

  %% CLI path
  C --> C1[Run: npm run cli -- <intent>]
  C1 --> C2{Result}
  C2 -->|OK| COK[Done]
  C2 -->|REFUSED| CR[Read refusal code]
  CR --> CR1[Open receipt if present]

  %% Provenance/Judgment
  A --> P{Provenance OK?}
  P -->|PASS| POK[Judgment cleared]
  P -->|FAIL| PFAIL[Judgment active]
  PFAIL --> J1[Only read-only allowed: Scan/Memory]
  PFAIL --> J2[Privileged blocked: Baseline/Apply/Restore]

  %% Approval
  A --> AP{Approval required?}
  AP -->|No| N1[Runs]
  AP -->|Yes| AP1[Provide approval reason]
  AP1 --> AP2{Controlled/Write?}
  AP2 -->|Yes| AP3[Confirm APPLY]
  AP2 -->|No| AP4[Runs]
```

## 3) What can I do here? (the “verbs”)

Most common intents:

- `scan` — read-only index / inventory
- `memory` — read-only integrity / policy checks
- `baseline pre` — privileged (writes artifacts + known-good)
- `baseline post` — typically read-only (depends on capability meta)
- `feneris` — may write scaffold (treat as privileged)

## 4) Why is it saying no? (fast decoding)

| You see | Meaning | Fastest next action |
|---|---|---|
| `obsidian_judgment` | Provenance failed; system is in “monitor-only” | Run `scan` / `memory`, then restore provenance (see below) |
| `approval_required` / `step_approval_required` | Governance requires explicit human approval | Provide approval reason (and identity if configured) |
| `confirm_required` | Mutating/controlled op requires explicit APPLY | Retry with confirm=APPLY |
| `write_disabled` | Writes are disabled by config/env | Set `AUERNYX_WRITE_ENABLED=1` (or config writeEnabled) |
| `direct_execution_disabled` | Tried to bypass plan/rails | Use normal intent route (CLI/VS Code) |

## 5) Provenance / Judgment: how to recover

Judgment becomes active when provenance verification fails (e.g., missing genesis while writes are disabled).

Quick recovery options:

- **Normal dev**: enable write once to create genesis
  - Set env `AUERNYX_WRITE_ENABLED=1`
  - Run a harmless read-only command (`scan`) to let genesis be created
  - Then rerun the privileged intent

- **Strict enforcement testing**: keep `AUERNYX_WRITE_ENABLED=0`
  - Expect Judgment to activate
  - Verify UI + refusal behavior

- **Config changed on a sealed install** (`governance_hash_mismatch`; `project_id_mismatch` after renaming the package): any edit to `config/auernyx.config.json` or `config/allowlist.json` after sealing trips Judgment. That includes a `git pull` that changes them.
  - Not intended: put the files back exactly as sealed. Judgment clears on the next run.
  - Intended: run `provenanceReseal` (intent text `reseal provenance`, since 2026-11-27):
    1. Preview with input `{}`: it shows why Judgment tripped, what changed in each file (compared with the sealed copy; secrets only as `[redacted]`) and `confirm.governanceHash`. Nothing is written.
    2. Apply with `{ "apply": true, "governanceHash": "<from the preview>" }`, typed APPLY, approved by the approver named in the seal (not the one in the edited config). The audit ledger and every self-test check must pass. If the config changes after the preview it refuses (`PREVIEW_STALE`). If the change isn't committed yet, the lifecycle also needs `allowDirty`.
  - It writes `.auernyx/provenance/seals/NNNNNN.json` (chained to the seal before it; `genesis.json` is never rewritten), a sealed copy in `.auernyx/provenance/sealed/`, a Kintsugi record and the receipt. It runs under Judgment, the governance lock and Kintsugi FAILED_CLOSED, but never clears the lock or FAILED_CLOSED (that's `governanceUnlock`).
  - A seal made before 2026-11-27 has no sealed copy, so it can't name its approver (`SEALED_APPROVER_UNKNOWN`): put the config back as sealed, run once with writes enabled (the copy is written then), then make the change again and re-seal.

- **Genesis deleted on an install that was already sealed** (`genesis_deleted`, since 2026-11-27): genesis is **not** re-created, even with writes enabled, so Judgment stays active (fail closed). "Already sealed" means any of: a `genesis.created` entry in `.auernyx/provenance/audit.ndjson`, Kintsugi ledger records, entries in `logs/ledger.ndjson`, seal records, or sealed copies. The refusal is logged as `genesis.recreate_refused` with that evidence.
  - Way out: `provenanceReseal`, same two steps. Damage to the seal itself is re-sealable with approval: genesis deleted, edited (`genesis_hash_mismatch`) or unreadable (`genesis_parse_error`), or a broken seal chain (`seal_chain_broken`: an edited, missing or out-of-order seal record). The approver is checked against the last surviving sealed copy, and the new seal is an anchor: verification restarts there, pinning `genesis.json` as it is now (or as absent).
  - If no sealed copy survived, it refuses (`NO_SEALED_COPY`): restore the original `genesis.json` from a backup, or, on a dev/test install only, wipe `.auernyx/` and `logs/` entirely (a full reset; all local audit history is lost).
  - A never-sealed install (only read-only runs so far) still seals normally on its first write-enabled run.

## 6) Debug (F5) profiles

In VS Code Run & Debug:

- **Auernyx Mk2: Dev Host (Judgment-First)**
  - `AUERNYX_WRITE_ENABLED=0`
  - Use for: UI verification, governance regression, refusal choreography

- **Auernyx Mk2: Dev Host (Write Enabled)**
  - `AUERNYX_WRITE_ENABLED=1`
  - Use for: normal development, capability testing

## 7) Clip art drop-in

Place your Judgment image here (preferred):

- `clients/vscode/obsedeansjudgement.png`

Fallback:

- `assets/judgment.png`

When Judgment is active at extension startup, it will try to open the image automatically.
