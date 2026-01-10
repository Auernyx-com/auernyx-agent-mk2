# Mk2 Decision Record: Branch Handshake + Auto-Discovery + Registry + Pruning (v1)

**Date:** 2026-01-08  
**Scope:** Mk2 TRUNK platform contract propagation, connected branch discovery, lifecycle, pruning  
**Status:** Adopted (v1)

## Problem
Manual maintenance of a compatibility matrix (listing “connected branches” by hand) creates drift and breaks the promise of Mk2 as TRUNK authority. Platform/runtime contract changes (Node/TS/ESM/scripts) can silently break connected branches.

## Decision
Connected branches must *self-identify* via a handshake file. Mk2 will auto-discover connected branches, generate a compatibility matrix, run volatility/canary checks, then propagate via PRs.

### Core Law
**A branch is not “connected” unless it contains a valid `.mk2/handshake.json`.**

## Handshake
Connected branches must include:

- Path: `.mk2/handshake.json`
- Must conform to: `.mk2/handshake.schema.json`
- Must declare lifecycle and required checks.

## Lifecycle States
- `ACTIVE`: Included in canary and eligible for propagation PRs.
- `BROKEN`: Excluded from propagation; remains visible for audit.
- `QUARANTINED`: Excluded; signals integrity risk; requires human attention.
- `RETIRED`: Excluded; eligible for pruning **only with prune receipt**.
- `PRUNED`: Historical terminal state after deletion; recorded by registry process.

## Automation Pipeline
1. **Staging branch** receives platform changes first.
2. **Auto-discovery** scans origin branches for handshake files.
3. Generator produces `branches/compat-matrix.generated.json`.
4. Canary suite runs for each connected branch (worktree merge + required checks).
5. If canary passes, propagation workflow opens PRs to each connected branch.

## Pruning & Forced Break
- **Force break:** change handshake lifecycle to `BROKEN` (optionally with receipt).
- **Prune:** handshake lifecycle `RETIRED` + TRUNK prune receipt required before deletion.

## Why This Works
- Removes manual wiring and prevents registry drift.
- Keeps TRUNK authoritative while allowing branches to self-declare compatibility needs.
- Encodes lifecycle in machine-readable form and enforces safe propagation/pruning.

## Non-Goals
- Training base LLM weights.
- Multi-repo propagation (v1 assumes same repo; can be extended).

## Artifacts
- Handshake schema + validator
- Matrix generator
- Canary + propagation workflows
- Registry PR workflow
- Prune workflow (receipt-gated)
