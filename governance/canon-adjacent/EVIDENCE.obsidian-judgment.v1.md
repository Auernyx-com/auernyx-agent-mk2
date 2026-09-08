# Evidence Consolidation — Obsidian Judgment (TRUNK) + Clear-Gating (SQUAD)

Date: 2026-01-05 (local)
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

## Update (2026-09-08) — the SQUAD-side mechanism this describes has had two further critical fixes

Both the "Behavioral change" section above and the "Reasons" list under it describe
the mechanism as it stood after the original 2026-01-05 commit
(`583ab9d716632684bd957b78894df300fedf5c1f`). An independent audit of the SQUAD repo
found and fixed two more severe gaps in the exact same `clear_judgment()` /
`rotate_genesis_record()` pair since then — this record is the closest thing to a
canonical description of that mechanism living in this repo, so it's worth stating
both here, not just in SQUAD's own copy (`MODULES/OBSIDIAN_JUDGMENT/EVIDENCE.clear-gating.md`):

1. **The `restoration_proof` check described above (line 53-55) was a tautology
   (SQUAD PR #38, critical).** `ref` + `sha256` only proved *some* file matched its
   own hash — trivially true of any file paired with its own digest. It never
   checked that the actual tampered file had been restored to anything. Confirmed
   with a direct probe: tamper a real governance file, let the judgment activate,
   craft a `restoration_proof` pointing at a completely unrelated, untouched file
   plus that file's own real hash — `clear_judgment()` returned `True` while
   `verify_provenance()` still reported the same tamper immediately afterward.
   Fixed by having `clear_judgment()` re-run `verify_provenance(repo_root)` after
   the ref/sha checks and refuse unless governance state actually matches genesis
   *right now*. ref/sha remain a required audit trail but no longer stand in for
   verification.

2. **The tamper-code check above (line 50, `failure.code == "governance_hash_mismatch"`)
   only covered 1 of 4 real tamper codes (SQUAD PR #46, critical).**
   `verify_provenance()` can also fail with `genesis_hash_mismatch`,
   `project_id_mismatch`, or `genesis_parse_error` — all at least as severe, all
   previously requiring zero restoration proof to clear. Fixed by treating any
   non-empty failure code other than `genesis_missing` (an uninitialized repo, not
   tamper) as requiring proof.

Both fixes apply to the SQUAD repo's module specifically — this Mk2-repo record
was never itself executable code, so nothing here needed a corresponding code
change. Recorded so a future reader of this evidence chain doesn't stop at the
2026-01-05 state and assume it's still current.
