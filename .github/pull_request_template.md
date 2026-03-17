## Authorization
- Record file: `governance/alteration-program/authorization/records/<YYYY-MM-DD-slug>.json`

## Governance Checklist (CI gate enforced — fail-closed)
- [ ] This PR changes or adds **exactly one** authorization record JSON under `governance/alteration-program/authorization/records/`
- [ ] The authorization record contains all required fields: `authorizedBy`, `authorizedAt`, `reason`, and `approvals`
- [ ] `authorizedBy` is a valid GitHub login present in `governance/alteration-program/authorization/allowlist.json`
- [ ] `authorizedAt` is a valid ISO date (`YYYY-MM-DD`) that is not in the future
- [ ] `approvals` list includes `"jason"`

## Scope (fail-closed)
- [ ] Changes are bounded to the declared scope
- [ ] This PR changes/adds exactly one authorization record file

## Verification
- Required checks per intent:
- Outputs/notes:

## Evidence (if governanceImpact=true)
- [ ] evidence.required=true
- [ ] receiptRefs added on close
