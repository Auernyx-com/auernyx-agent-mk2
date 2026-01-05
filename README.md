# Auernyx Agent

Embedded assistant persona for guidance, analysis, and tooling inside VS Code.

## Structure

```
auernyx-agent/
├── package.json
├── tsconfig.json
├── README.md
├── core/
│   ├── server.ts            # daemon entry
│   ├── router.ts            # intent -> capability mapping
│   ├── policy.ts            # allowlist, approvals, safeguards
│   ├── state.ts             # session + working memory
│   └── ledger.ts            # append-only logs + hashes
├── capabilities/
│   ├── scanRepo.ts
│   ├── fenerisPrep.ts
│   ├── baselinePre.ts
│   ├── baselinePost.ts
│   └── docker.ts
├── clients/
│   ├── cli/
│   │   └── auernyx.ts        # command-line entry
│   └── vscode/
│       └── extension.ts      # thin wrapper only
├── config/
│   ├── auernyx.config.json
│   └── allowlist.json
├── logs/                     # runtime logs (ignored by git)
└── artifacts/                # bundles, reports (ignored by git)
```

## Installation

1. Clone this repo
2. `npm install`
3. `npm run compile`
4. Open in VS Code and press F5 to debug

## Commands

- **Ask Auernyx** — Direct interaction with the agent
- **Scan Repo (Auernyx)** — Index and analyze workspace structure
- **Prepare Feneris Port** — Generate Windows Feneris scaffolding

## Non-VS Code usage

This repo also supports running Auernyx outside VS Code via a local daemon and a CLI client.


Windows convenience launchers:

- `Launch-Auernyx.cmd` (recommended): single double-click entry point that lets you choose:
	- Headless daemon (browser UI)
	- VS Code interface


### Web UI (no VS Code)

If VS Code is unavailable, start the daemon and open the built-in UI in a browser:

- Start: `auernyx-daemon --root .`
- Open: `http://127.0.0.1:43117/ui`

Notes:

- If you set a daemon secret (`AUERNYX_SECRET` or `config/auernyx.config.json`), enter it into the UI “Secret” field.
- The agent is **read-only by default**. Enable disk writes only when you’re intentionally working on the repo:
	- `AUERNYX_WRITE_ENABLED=1`

The browser UI is a control surface, not a privileged channel. All requests are subject to the same governance guard, write lock, approval friction, and refusal semantics as any other client.

### CLI approvals (non-interactive)

The CLI supports non-interactive approvals so automation doesn’t hang on prompts:

- `--reason <TEXT>` (required to skip prompts)
- `--identity <TEXT>` (only required when `governance.approverIdentity` is configured)
- `--apply` (required for any mutating operation)
- `--confirm APPLY` (legacy; implied by `--apply`)

Examples:

- Baseline pre-check (mutating; requires explicit APPLY):
	- `AUERNYX_WRITE_ENABLED=1 npm run cli -- baseline pre --reason "baseline pre-check" --apply`
- Read-only checks (no APPLY needed):
	- `npm run cli -- scan . --reason "work check: scan"`
	- `npm run cli -- memory --reason "work check: memory"`

### Receipts API (read-only)

If receipts are enabled and a run produces a receipt, the daemon can serve receipt metadata and artifacts:

- List receipts: `GET /receipts?limit=25`
- List receipt files: `GET /receipts/<runId>`
- Fetch receipt file: `GET /receipts/<runId>/<fileName>`

Notes:

- These endpoints require the daemon secret when one is configured.
- Receipts are stored under `.auernyx/receipts/`.
- Receipts can be disabled with `AUERNYX_RECEIPTS_ENABLED=0`.

### Orchestrator API (plan → approve → execute)

Mk2 runs capabilities through a governed orchestrator loop:

- Plan: `POST /plan` with `{ intent, input }`
- Execute step: `POST /step` with `{ intent, input, stepId, approval }`

`POST /run` remains primarily for meta intents (e.g. `capabilities`, `status`) and for compatibility, but governed execution is enforced via the plan/step flow.

### Controlled write path: Search index update

Mk2 includes one canonical controlled-write example that is fully governed:

- **Intent:** `search doc`
- **Input JSON** (examples):
	- Add/update an entry:
		- `{ "action": "add", "docPath": "docs/thing.md", "title": "Thing" }`
	- Remove an entry:
		- `{ "action": "remove", "docPath": "docs/thing.md" }`

Behavior:

- The planner emits a **two-step plan**:
	- `step-1` (READ_ONLY): `searchDocPreview` (dry-run preview + before/after hashes)
	- `step-2` (CONTROLLED_WRITE): `searchDocApply` (writes `docs/SEARCH.md`)
- `step-2` requires explicit approval with `confirm=APPLY`.
- The receipt captures the preview/apply outputs, including before/after hashes.

### Governance law (invariants)

The invariants that define Mk2’s governance model are documented here:
- [docs/mk2-governance-law.md](docs/mk2-governance-law.md)

## Kintsugi governance storage (repo-local)

Mk2 stores Kintsugi governance/audit artifacts under:
- `.auernyx/kintsugi/`

This includes the Kintsugi policy history and a write-once, hash-chained ledger of governance records.

Note: `.auernyx/kintsugi/` is a protected path; governed mutations must refuse writes into Kintsugi audit/policy/ledger locations.

## Architecture

- `core/` — routing, policy, state, and ledger
- `capabilities/` — action modules (scan, prep, baseline, etc.)
- `clients/vscode/extension.ts` — VS Code integration only (thin wrapper)

The VS Code client routes intents into allowlisted capabilities.

---

**Status:** Skeleton complete. Ready for integration.
