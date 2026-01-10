# Mk2 Branch Lifecycle Law (v1)

## Definitions
- **TRUNK (Mk2):** Governance authority defining platform contract and validation rules.
- **Connected branch:** Any branch that contains a valid `.mk2/handshake.json`.
- **Platform contract:** Node/TS/ESM/scripts toolchain assumptions required to run governance tooling.

## Rules
1. A branch without a valid handshake is **not connected**.
2. Only `ACTIVE` branches are included in volatility/canary tests by default.
3. Only branches that pass canary are eligible for propagation PRs.
4. `BROKEN` and `QUARANTINED` branches are excluded from propagation.
5. `RETIRED` branches may be pruned only if a **prune receipt** exists in TRUNK.
6. Pruning must be logged (registry update PR) and should end in `PRUNED` state.

## Allowed Lifecycle Transitions
- `ACTIVE -> BROKEN`
- `ACTIVE -> QUARANTINED`
- `ACTIVE -> RETIRED`
- `BROKEN -> ACTIVE` (only after fixes + canary pass)
- `QUARANTINED -> ACTIVE` (only after integrity review)
- `RETIRED -> PRUNED` (receipt-gated)

## Receipts
Pruning requires an auditable event confirming approval. v1 supports a minimal receipt gate:
- `PRUNE_APPROVED` contains target branch name and approval metadata.
