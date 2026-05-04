# Feneris Founding Incident

**Status:** CLOSED  
**Date:** Pre-repository (before 2026-01-03)  
**Detected by:** Human (manual discovery)  
**Disposition:** Credentials rotated. Governance system built as structural response.

---

## What happened

Sensitive credentials — an email address and password — were accidentally committed to the
repository and pushed to the remote. The push was discovered and remediated: credentials were
rotated and the exposure was contained. No confirmed downstream exploitation.

This incident is not in the git history because it predates the governance model. It is
documented here because it is the direct origin of everything Feneris was built to do.

---

## Why it matters

At the time, there was no watchdog. No system checked whether sensitive data was being
committed. No infraction was raised, no evidence was collected, no HIL disposition was
required. The exposure went from commit to push to discovery entirely outside any
governance structure.

Feneris exists because of this gap. Its job is to raise that infraction — with evidence,
with scoring, with a record that persists — before the damage is already done or immediately
after, so it cannot be forgotten.

---

## Feneris Assessment (retroactive)

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Scope | 7 | Repository-wide exposure. All forks and clones at the time of push had access. |
| Severity | 9 | Credentials are directly usable. No decryption or inference required. |
| Sensitivity | 10 | Email + password = authentication data. Highest sensitivity category. |
| Blast Radius | 8 | Any system sharing those credentials was potentially reachable. Propagation was limited only by rotation speed. |

**Origin point:** `check:credential-exposure|component:vcs|path:git-history`

**Rationale:** Authentication credentials committed to version control and pushed to a
remote repository. Score reflects the directness of the exposure vector and the
irreversibility of push without rotation. Blast radius capped at 8 rather than 10 because
the credential scope was known and rotation was the effective containment.

---

## HIL Assessment

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| Scope | 7 | Agree — exposure was repository-scoped. |
| Severity | 9 | Agree — direct credential exposure. |
| Sensitivity | 10 | Agree — no ambiguity on sensitivity ceiling. |
| Blast Radius | 7 | Slightly lower — blast radius was limited by the systems the credential was actually used for. |

**Assessed by:** Ghostwolf101  
**Rationale:** The divergence on blast radius (8 vs 7) is a calibration note: Feneris scores
potential propagation assuming worst-case credential reuse; HIL scores actual known exposure
scope. Both are valid — this is exactly the kind of signal the dual-assessment model is
designed to preserve.

---

## Disposition

**Status:** closed  
**Decided by:** Ghostwolf101  
**Reason:** Credentials rotated. Repository history remediated. The structural response was to
build the governance system that became Auernyx Mk2, with Feneris as the sentinel that would
catch this class of violation going forward.

---

## Legacy

This is the first infraction Feneris was designed to prevent.

The scar that made the gold visible.
