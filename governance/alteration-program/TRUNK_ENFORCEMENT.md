# Trunk Enforcement (Merge-Blocking Rules)

CI is the authority. Local tooling may assist, but does not replace enforcement.

## Required for every PR
- PR must change/add exactly one intent file:
  `governance/alteration-program/intent/*.json`
- Intent must validate invariants and schema-required fields
- Intent filename must equal its `intentId`

## Required when governanceImpact=true
- evidence.required=true (fail-closed)
- receiptRefs required on close

## Fail-closed
Merge is blocked if any requirement fails.

Trace files: if a trace file has no base version (first introduction), it is treated as a new file and must then be append-only from that point forward.
