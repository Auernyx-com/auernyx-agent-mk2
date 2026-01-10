# Yggdrasil-Aligned Alteration Program (Mk2-Class Systems)

This program governs **how changes are made** to Mk2-class systems (including Skjoldr), not what those systems do.

## Non-negotiables
1. Fail-closed by default.
2. Determinism over convenience.
3. Proof over explanation.
4. Process before feature.
5. Environment-agnostic (portable across machines/networks).
6. Human-readable, machine-enforceable.

## Yggdrasil model
- Root: doctrine + schemas defining lawful change.
- Trunk: repo-wide enforcement (CI, required checks, PR structure).
- Branches: optional operator tooling (VS Code tasks, local helpers).
- Leaves: individual changes/patches that must conform and produce proof.

## Alteration lifecycle
INIT (Intent) -> VERIFY (Proof) -> CLOSE (Receipt)

## Append-only rule (anti-wave-in)
Intent is not silently edited after review begins.
Changes are made via `amendments[]` entries with timestamp, actorId, reason, fieldsChanged.

## Classification requirement
Every change declares its class: root / trunk / branch / leaf.
