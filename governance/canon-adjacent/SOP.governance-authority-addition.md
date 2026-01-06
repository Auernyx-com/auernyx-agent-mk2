# SOP — Add a Governance Authority (TRUNK, canon-adjacent)

Purpose: Add/adjust governance authorities as **TRUNK law artifacts** only (schema-only), keeping changes maintenance-safe and auditable.

Non-goals:
- No runtime wiring
- No new workflows/UI
- No hidden behavior

## Inputs (operator must provide)
- Authority `id` (lowercase): e.g. `sovreth`
- Blade JSON (v1) and constraint JSON (v1)
- Roster order placement (must preserve canonical index shape)
- Optional Mnēma tie-in invariant(s)

## File layout (required)
Add exactly:
- `governance/canon-adjacent/blades/<id>.blade.v1.json`
- `governance/canon-adjacent/constraints/<id>.constraint.v1.json`

Then wire:
- `governance/canon-adjacent/index.v1.json`
  - Preserve exact shape: `{ schema, scope, members }`
  - Add member: `{ "id": "<id>", "blade_ref": "blades/<id>.blade.v1.json" }`
- Optional (recommended when authority is structural): `governance/canon-adjacent/constraints/mnema.constraint.v1.json`
  - Add invariant(s) with `hard_refusal`

## Metadata rules
- Constraint `metadata` may reference schema-only dependencies (approval/infraction/judgment) even if unused yet.
- No new schema formats unless explicitly authorized.

## Proof battery (required; no vibes)
Run all:
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/qa/Scan-RetiredBrand.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/qa/Scan-HardcodedPaths.ps1`
- `npm run compile`
- `powershell -NoProfile -ExecutionPolicy Bypass -File tools/smoke-topdown.ps1` (gold checkpoint)

Expected: all PASS.

## Evidence update (required)
Update:
- `governance/canon-adjacent/EVIDENCE.obsidian-judgment.v1.md`

Add/refresh a section per authority addition:
- File paths added
- Index roster order
- Mnēma invariant(s) added (if any)
- Commit SHA(s) **with**:
  - branch name (e.g. `branches/kotlin-consumer`)
  - tag placeholder (`TBD` until tagged)
  - proof battery reference (e.g. “Mk2 PASS list above”)

## Commit discipline (required)
1) Keep **governance authority changes** in their own commit.
2) Keep unrelated hygiene (linters/analyzers) in separate commit(s).
3) Evidence updates may be either:
   - included in the same governance commit, OR
   - a tiny follow-on doc commit (acceptable if it only records SHAs/proof refs)

Template commit message (governance authority):
- `governance: add <Name> <role>; wire roster; <Mnema tie-in summary>`

## Notes
- Roster order should reflect authority chain and avoid circularity.
- TRUNK stays honest even if a branch fails.
