# Smoke Topdown

This is the **“is it actually broken or am I tired”** regression guard.

## What it does (in order)

The script [tools/smoke-topdown.ps1](../tools/smoke-topdown.ps1) runs these steps:

1. Kill stale daemon + locks
2. Start daemon **read-only**
3. Verify HTTP negotiation (HTML by default, JSON when requested)
4. Run CLI **read-only** checks
5. Run **controlled** operations locally (forces `--no-daemon` + requires `--apply`)
6. Assert `.auernyx/provenance/genesis.json` exists
7. Exit non-zero on any failure

## When to run it

- After any routing/governance change
- When a controlled operation “looks broken” but might just be routed to a read-only daemon
- Before/after a baseline cycle if you want quick confidence

## How to run

From repo root:

- Run the launcher menu and pick **Smoke Topdown**, or
- Run directly:
  - `powershell -NoProfile -ExecutionPolicy Bypass -File tools/smoke-topdown.ps1`

A log is written to `logs/smoke-topdown.log` (and `logs/` is gitignored).

## Expected output

- On success, the last line is:
  - `[SMOKE] PASS`

- On failure, the last line is:
  - `[SMOKE] FAIL (see <path-to-log>)`

Exit codes:
- `0` = PASS
- `2` = FAIL

## Common failures and what they mean

- **Read-only daemon routing**: controlled ops are expected to be refused by a read-only daemon. Smoke topdown forces controlled ops to run locally via `--no-daemon`.
- **Missing genesis**: if `.auernyx/provenance/genesis.json` is missing, controlled operations may be refused by provenance enforcement. Fix by enabling a write-capable local run that creates genesis.
- **Daemon doesn’t come ready**: port collision, stale process, or firewall. The first step attempts to kill stale listeners; if this repeats, inspect the log.

