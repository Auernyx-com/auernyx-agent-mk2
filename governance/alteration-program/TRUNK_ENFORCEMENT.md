# Trunk Enforcement (Merge-Blocking Rules)

CI is the authority. Local tooling may assist, but does not replace enforcement.

This file describes what CI actually enforces today. The gate logic lives in
`tools/ci_gate.py`, run by the `gate` job in `.github/workflows/mk2-alteration-gate.yml`.
If this file and the code disagree, the code wins. Fix this file.

## Required status checks on `main`
Branch protection blocks a merge unless all of these pass, and it applies to
admins too:
- `gate` (alteration gate, below)
- `test` (`ci-tests.yml`: `npm ci`, typecheck, test suite)
- `kotlin-proof` (`ci-tests.yml`: Kotlin proof battery + TS/Kotlin parity)
- `Analyze (javascript-typescript)` and `Analyze (python)` (CodeQL)

The "avars" ruleset also requires `gate`, linear history, and a pull request.

## What the gate checks (every PR)
1. No illegal nested path `updates/updates`.
2. `updates/incoming/` holds no committed payload files (only `.gitkeep`).
3. Trace files are append-only: the base version must be an exact prefix of the
   new version. Trace files:
   - `governance/alteration-program/logs/update_apply.ndjson`
   - `governance/alteration-program/logs/bastion_secondary.ndjson`
   - `governance/alteration-program/logs/ui_actions.ndjson`

   A trace file with no base version (first introduction) is treated as new and
   must be append-only from then on.
4. The PR changes or adds at least one authorization record:
   `governance/alteration-program/authorization/records/*.json`
5. Every changed record must:
   - have `authorizedBy`, `authorizedAt`, `reason`
   - have `authorizedBy` be a valid GitHub login listed in
     `governance/alteration-program/authorization/allowlist.json`
   - have `authorizedAt` be an ISO date (`YYYY-MM-DD`), not in the future
   - have a non-empty `reason`
   - have been introduced by the exact commit the `auto-authorize` job vouches
     for (`MK2_RECORD_COMMIT_SHA`). A hand-written record fails, even with
     valid-looking fields.

A PR with zero changed files passes as a no-op.

## How a PR gets authorized
You don't write the record by hand. The `auto-authorize` job writes and pushes
it when either:
- the PR author is on the allowlist, or
- an allowlisted login has **approved** the PR.

Being assigned, or requested as a reviewer, does not count.

## Known snag: the record commit doesn't start checks
The record is pushed with `GITHUB_TOKEN` and tagged `[skip ci]`, so the new
HEAD gets no `test` / `kotlin-proof` runs that count toward the PR. Closing
and reopening the PR does **not** fix it (the skip marker suppresses those
runs too).

**Workaround:** push one more commit on top whose message does not contain
the skip-ci marker anywhere (an empty commit is fine). That starts a normal
`pull_request` run and the required checks report.

Repo policy is no secrets stored on GitHub, so the optional push-token path
in the workflow is intentionally not configured.

## Fail-closed
Merge is blocked if any requirement fails.

## No longer enforced
Older versions of this file required exactly one intent file
(`governance/alteration-program/intent/*.json`) per PR, plus
`governanceImpact` / `evidence.required` / `receiptRefs` rules. `ci_gate.py`
no longer checks any of these. The authorization record above replaced the
intent file on 2026-02-20 (#60, #61); the forged-record check was added
2026-09-07 (#179). `dependabot-gate.yml` still generates
intent files for Dependabot PRs, but nothing enforces them.
