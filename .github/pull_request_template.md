## Intent
- Intent file: `governance/alteration-program/intent/<intentId>.json`
- Intent ID: `<intentId>`

## Governance Checklist (CI gate enforced — fail-closed)
- [ ] This PR changes or adds **exactly one** intent JSON under `governance/alteration-program/intent/`
- [ ] The intent filename matches the `intentId` field (format: `<13-digit-timestamp>-<8-hex-chars>.json`)
- [ ] If this modifies a **closed** intent, a new `amendments[]` entry has been added documenting the change

## Scope (fail-closed)
- [ ] scope.in and scope.out are complete and bounded
- [ ] this PR changes/adds exactly one intent file

## Verification
- Required checks per intent:
- Outputs/notes:

## Evidence (if governanceImpact=true)
- [ ] evidence.required=true
- [ ] receiptRefs added on close
