# Kintsugi Failure Records

Append-only git-tracked log of governance and security failures recorded under
Kintsugi protocol.  This file is the single source of truth for failure records
that must survive across environments (unlike the runtime `.auernyx/kintsugi/`
store, which is gitignored and local-only).

**Rules (enforced by `tools/ci_gate.py`):**
- This file is **append-only**.  Existing entries must not be modified or removed.
- Every PR that touches a governance-critical path must add exactly **one** new
  entry to this file.
- Entry IDs follow the format `KFRID-YYYYMMDD-NNNN` (sequential within a day).

**Governance-critical paths (trigger failure-record requirement):**
- `tools/ci_gate.py`
- `.github/workflows/`
- `core/kintsugi/`
- `governance/alteration-program/`

---

## Entry template

```
## KFRID-YYYYMMDD-NNNN | YYYY-MM-DD | <Classification> — <Short title>

**Incident ID**: KFRID-YYYYMMDD-NNNN
**Date**: YYYY-MM-DD
**Classification**: <Security | Governance | Process | Quality>
**Reporter**: <GitHub login>
**Related PR(s)**: #NNN

### Summary
One-paragraph description of what happened.

### Impact / Risk
What harm could have occurred or did occur.

### Root Cause
Why it happened.

### Corrective Action
What was done to fix or mitigate the issue.

### Prevention
Process, tooling, or policy changes to prevent recurrence.
```

---

## KFRID-20260220-0001 | 2026-02-20 | Security — Hardcoded Approver (`.json` → `jason` misread)

**Incident ID**: KFRID-20260220-0001
**Date**: 2026-02-20
**Classification**: Security / Governance
**Reporter**: Ghostwolf101
**Related PR(s)**: #67, #68

### Summary
During the implementation of PR #67 (mk2-alteration-gate: no-op diff pass +
authorization-record enforcement), the acceptance criteria contained the
requirement `authorizedBy must equal "jason"`.  This was introduced because a
human reviewer misread the string `".json"` (a file-extension token in
surrounding context) as the name `"jason"`, which was then treated as a required
approver identity.  The misread propagated into `tools/ci_gate.py` as a
hardcoded constant (`REQUIRED_APPROVER = "jason"`) and into an `approvals`
list check (`"jason" not in approvals`), and the name `"jason"` was also added to
`governance/alteration-program/authorization/allowlist.json` as an authorized
login with no corresponding real identity on record.

### Impact / Risk
1. **Hardcoded single-approver backdoor** — any authorization record that did
   not list `"jason"` in its `approvals` array would be rejected, making `jason`
   a de-facto veto gatekeeper with no legitimate identity backing it.
2. **Allowlist contamination** — `"jason"` entered the authorizedLogins
   allowlist, meaning future records could legitimately authorize as `jason`
   without a corresponding real GitHub identity or governance approval.
3. **EU AI Governance compliance risk** — hard-coded identity strings in
   automated governance checks contravene transparency and auditability
   requirements; such identities must be traceable and removable through
   documented governance process.
4. **Audit trail gap** — because the failure was never formally recorded,
   the misread identity persisted across multiple commits without remediation.

### Root Cause
No git-tracked, CI-enforced failure record existed.  Governance failures were
meant to be recorded under Kintsugi protocol but this was only manually implied
and repeatedly deferred.  Without a mandatory failure-record step in the
alteration gate, the incident was not captured and the hardcoded reference
survived review.

### Corrective Action
- PR #68 introduces this file (`docs/kintsugi-failure-records.md`) as the
  git-tracked, append-only failure ledger.
- `tools/ci_gate.py` is updated to remove `REQUIRED_APPROVER = "jason"` and
  the `approvals["jason"]` check entirely; authorization relies solely on
  `allowlist.json`.
- `"jason"` is removed from `governance/alteration-program/authorization/allowlist.json`.
- The alteration gate is extended to require exactly one new KFRID entry in
  this file whenever governance-critical paths are changed.

### Prevention
- **CI enforcement**: `tools/ci_gate.py` now fails-closed if any
  governance-critical path is changed without a corresponding KFRID entry
  appended to this file.
- **No hardcoded identities in gate logic**: approver validation must always
  delegate to `allowlist.json`; no login string may appear as a constant in
  gate code.
- **Allowlist hygiene**: additions to `allowlist.json` require an authorization
  record with `reason` explaining the identity and their role.
