# Changelog

## 2026-01-03

- Added top-down regression guard script to validate daemon routing, negotiation, read-only checks, and controlled operations.
- Improved VS Code refusal UX to clearly explain read-only daemon routing and the correct next step.
- Extended launcher to include Smoke Topdown entrypoint and future packaging handoff (cmd → exe) via config.
- Added deterministic icon pipeline (multi-size .ico) and a Desktop shortcut generator using the icon.
- Made CLI read-only-daemon reroute hints PowerShell-friendly (informational output no longer trips error handling when the CLI successfully recovers by routing locally).

## 2026-01-05

- Milestone: Kotlin consumer sweep v1 (isolated under `branches/kotlin-consumer`) with locked decision/refusal codes, digest verification, governance receipt emission, and a passing proof battery.
- Added a hostile stress branch (`branches/kotlin-consumer-hostile`) with a digest-fuzzer test to prove refusal logic under load.
- Formalized trunk freeze semantics by anchoring on `yggdrasil-trunk@v1` as contract law (no contract changes without an intentional version bump).
- Added one-click repo tasking for Kotlin verification via `.vscode/tasks.json` (Kotlin Proof Battery + Kotlin CLI Preview Run).

## 2026-01-09

### Note on Milestone 2026-01-05

A correction addendum was recorded on 2026-01-09 clarifying the impact of an LLM model context shift (OpenAI 5.2 → 4.1) and the resulting verification hardening.
See `docs/MILESTONE_20260105.md` for details.

## 2026-01-10

- Fixed volatility handshake validation for JSON Schema draft 2020-12 by using Ajv’s 2020 build (prevents “no schema with key or ref …/draft/2020-12/schema”).
- Pruned merged/closed branches from origin: `branches/kotlin-consumer-hostile`, `copilot/nitpick-remove-unused-parameter`.
- Pruned stale remote refs after merges: `dependabot/npm_and_yarn/types/node-25.0.5`, `dependabot/npm_and_yarn/types/vscode-1.108.1`, `trunk/mk2-alteration-program`.

