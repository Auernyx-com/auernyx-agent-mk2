# Milestone — 2026-01-05

## Frozen anchors

- Trunk contract anchor: `yggdrasil-trunk@v1`
  - Meaning: contract law is frozen; changes require an explicit version bump.

- Kotlin consumer anchor: `yggdrasil-kotlin-consumer@v1`
  - Meaning: Kotlin verifier/receipt emitter v1 is locked and reproducible.

## What was achieved

- Kotlin consumer sweep v1 under `branches/kotlin-consumer/`:
  - Strict envelope parsing
  - Canonical payload digest verification (SHA-256)
  - Locked decision/refusal codes
  - Governance receipt emission + deterministic JSON + receipt hash
  - Passing proof battery (`gradlew test`)

- Hostile test branch `branches/kotlin-consumer-hostile`:
  - Digest-fuzzer stress test that exists only to fail if refusal logic weakens

## Boring verification hooks

- VS Code task: Kotlin Proof Battery
- VS Code task: Kotlin CLI Preview Run

## Closeout drill

- Baseline POST at end of workday and record SHA-256 in `docs/baseline-records.md`
- SHA-256 verify smoke entrypoint (tools/smoke-topdown.ps1)
- Push branches and tags before closeout

## Correction / Addendum (2026-01-09)

After this milestone was recorded, an important context clarification was identified.

During the period leading up to this milestone, the active LLM model shifted from OpenAI 5.2 to 4.1 without an explicit pin or invariant enforcing model continuity. While the interface and behavior appeared consistent, the underlying reasoning guarantees differed.

This model substitution exposed a latent trust assumption: governance logic and safeguards were designed correctly, but executor identity (the LLM model itself) was not explicitly anchored as part of the trust boundary.

As a result, additional hardening and verification steps were introduced immediately after this milestone, including:
- restoration and enforcement of `npm run verify`
- cross-language (TypeScript + Kotlin) contract validation
- proof batteries that fail closed on missing fields, digest mismatch, and schema drift
- explicit refusal of always-succeeds stubs or synthetic identities

This addendum does not invalidate the original milestone.
It clarifies the conditions under which it was achieved and documents the corrective actions taken to ensure long-term trustworthiness.

Milestone status remains **valid**, with this correction recorded for historical accuracy.
