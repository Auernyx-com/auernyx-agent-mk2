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


### Web UI (no VS Code)

If VS Code is unavailable, start the daemon and open the built-in UI in a browser:

- Start: `auernyx-daemon --root .`
- Open: `http://127.0.0.1:43117/ui`

Notes:

- If you set a daemon secret (`AUERNYX_SECRET` or `config/auernyx.config.json`), enter it into the UI “Secret” field.
- The agent is **read-only by default**. Enable disk writes only when you’re intentionally working on the repo:
	- `AUERNYX_WRITE_ENABLED=1`

The browser UI is a control surface, not a privileged channel. All requests are subject to the same governance guard, write lock, approval friction, and refusal semantics as any other client.

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
