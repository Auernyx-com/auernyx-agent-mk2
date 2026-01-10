# Evidence Consolidation — Obsidian Judgment (TRUNK) + Clear-Gating (SQUAD)

Date: __________ (local)
Scope: TRUNK law artifacts (Mk2) + minimal enforcement change (SQUAD module)
Mode: Maintenance-safe (schema + law artifacts, no new workflows)

## Summary (What changed)
- Added Obsidian as a TRUNK law authority with a formal judgment schema (v1).
- Wired Obsidian into the canonical TRUNK roster and Mnēma canon constraints.
- Hardened Obsidian Judgment module (SQUAD) to refuse clearing a judgment when core/author tamper is indicated unless restoration proof exists and is hash-verified.
- Added receiptable audit events for “clear refused” reasons.

## Added (Mk2 — TRUNK law artifacts, schema-only)
- governance/canon-adjacent/schemas/aesir.governance.judgment.v1.json
- governance/canon-adjacent/blades/obsidian.blade.v1.json
- governance/canon-adjacent/constraints/obsidian.constraint.v1.json

## Updated (Mk2 — required TRUNK wiring)
- governance/canon-adjacent/index.v1.json
  - Shape unchanged (only: schema, scope, members)
  - Roster order: bastion, mnema, sovreth, obsidian, ghost, feneris, ueden, mueden
- governance/canon-adjacent/constraints/mnema.constraint.v1.json
  - Added: judgment_schema_ref -> schemas/aesir.governance.judgment.v1.json
  - Added 4 invariants (hard_refusal):
    - MNEMA.JUDGMENT.APPEND_ONLY
    - MNEMA.JUDGMENT.EVIDENCE_REQUIRED
    - MNEMA.JUDGMENT.HITL_REQUIRED_FOR_NON_STOP_DECISIONS
    - MNEMA.JUDGMENT.NO_CLEAR_WITHOUT_RESTORATION_PROOF

  ## Sovreth Addition
  Files added (Mk2 — TRUNK law artifacts, schema-only):
  - governance/canon-adjacent/blades/sovreth.blade.v1.json
  - governance/canon-adjacent/constraints/sovreth.constraint.v1.json

  Index roster order:
  - bastion, mnema, sovreth, obsidian, ghost, feneris, ueden, mueden

  Mnēma invariant added:
  - MNEMA.CANON.CHANGES_REQUIRE_SOVRETH (hard_refusal)

  Commit (Mk2):
  - SHA: a9d973854089cfbf2e59644d3233cadb79c292d3

## Behavioral change (SQUAD — Obsidian Judgment module)
File:
- Projects/SQUAD/MODULES/OBSIDIAN_JUDGMENT/src/obsidian_judgment.py

Change:
- clear_judgment() now refuses to clear when:
  - active failure indicates core/author tamper (failure.code == "governance_hash_mismatch")
  - OR decision.restoration_required == true
  - AND restoration_proof is missing/invalid.
- restoration_proof is valid only if:
  - restoration_proof.ref exists (absolute or repo-root-relative supported)
  - and sha256 matches the referenced local file.

Receiptable audit event:
- Emits: judgment.clear_refused
- Reasons (string codes):
  - restoration_proof_missing
  - restoration_proof_ref_missing
  - restoration_proof_hash_mismatch

Non-goals (explicitly NOT added):
- No auto-restore
- No auto-fallback
- No autonomous proceed/resume decisioning
- No workflow/UI changes

## Invariants introduced (Obsidian)
Obsidian constraint invariants (hard_refusal):
- OBSIDIAN.JUDGMENT.APPEND_ONLY
- OBSIDIAN.JUDGMENT.EVIDENCE_REQUIRED
- OBSIDIAN.PREVENTIVE_DAMAGE.REQUIRES_FULL_PROOF
- OBSIDIAN.ONLY_STOP_PAUSE_WITHOUT_HITL
- OBSIDIAN.HITL_REQUIRED_FOR_NON_STOP_DECISIONS
- OBSIDIAN.TAMPER.AUTHOR_OR_CORE.HARD_STOP
- OBSIDIAN.TAMPER.RESTORE_REQUIRED_BEFORE_RESUME

## Proof battery results
Mk2:
- Retired-brand scan: PASS
- Hardcoded-path scan: PASS
- npm run compile: PASS
- Top-down smoke: PASS

SQUAD:
- Python syntax: py -3 -m py_compile <module>: PASS

## Commits
Mk2 commit:
- Message: governance: add Obsidian judgment schema + blade/constraints; wire into index + Mnema
- SHA: f31ac3ef3a95e095e11cc9f462fd11c8be1c731e (branch: branches/kotlin-consumer; tag: TBD; proof: Mk2 PASS list above)

SQUAD commit:
- Message: obsidian: refuse clear on core/author tamper without restoration proof
- SHA: 583ab9d716632684bd957b78894df300fedf5c1f (branch: governance/wip-provenance-mismatch; tag: TBD; proof: SQUAD PASS list above)

Mk2 commit (Sovreth addition):
- SHA: a9d973854089cfbf2e59644d3233cadb79c292d3 (branch: branches/kotlin-consumer; tag: TBD; proof: Mk2 PASS list above)

## Notes
- This change set strengthens auditability and prevents “usability edits” from bypassing author/core governance protection.
- STOP/PAUSE remains the only pre-authorized decision; any non-stop decision requires HITL approval and must be receipted.
