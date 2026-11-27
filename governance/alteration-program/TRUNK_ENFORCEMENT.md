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
Normal path: open the PR with **`tools/open-pr.sh "<title>" [body-file]`**
from your feature branch. It writes the authorization record
(`records/<date>-branch-<branch>.json`), commits it as you, pushes, and opens
the PR. Because the record arrives in your own push, `auto-authorize` finds it
and pushes nothing, your commit stays the PR head, and every required check
runs on the first try. The script refuses if your GitHub login is not on the
allowlist.

The record only counts when `auto-authorize`, on that run, checks live that
either:
- the PR author is on the allowlist, or
- an allowlisted login has **approved** the PR.

Being assigned, or requested as a reviewer, does not count. A record written
by anyone else still fails the gate (forged-record check above).

## Dependabot PRs: authorized by approval, recorded after merge
Nothing but Dependabot may push to a Dependabot branch. Any other push
(record commit, empty commit) leaves the head with no checks **and** makes
Dependabot stop managing the PR, so it never rebases it or closes it when a
newer version supersedes it, and duplicates pile up.

1. **Authorization = Justin's approval.** The `dependabot-approval` job
   (read-only, uses main's rules) passes the gate only when an allowlisted
   login's latest review is APPROVED (a later "request changes" cancels it),
   every commit is Dependabot's own GitHub-verified commit, and only
   `package.json` / `package-lock.json` change. Approving re-runs the gate.
   Until then `gate` fails with "waiting for approval". The approval is
   bound to the PR, so `@dependabot rebase` keeps it.
2. **Record at approval:** the job writes the full record (approver, review
   ID, commit, change) to its job summary.
3. **Record in the repo after merge:** every non-Dependabot PR fails the gate
   while a Dependabot merge on main (since 2026-11-27) has no
   `records/<date>-dependabot-pr-<N>.json`. `tools/open-pr.sh` files them
   (via `tools/backfill-dependabot-records.js`) in the same commit as the
   PR's own record. `auto-authorize` re-checks every fact in them against
   GitHub (merged, Dependabot-only, approved by an allowlisted login before
   the merge, same merge commit) before the gate trusts them.

If a Dependabot PR picked up foreign commits, comment `@dependabot recreate`
to rebuild it clean. `dependabot-gate.yml` (intent files, unenforced since
2026-02-20) was removed 2026-11-27.

## Fallback: PR opened without the script
If the PR has no record (opened by hand),
`auto-authorize` writes it and pushes it with `GITHUB_TOKEN`, tagged
`[skip ci]`. GitHub never starts check runs for that push, so the new head
gets no `test` / `kotlin-proof` runs that count toward the PR. Closing and
reopening the PR does **not** fix it (the skip marker suppresses those runs
too).

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
2026-09-07 (#179). `dependabot-gate.yml`, which kept generating unenforced
intent files for Dependabot PRs, was removed 2026-11-27 (#209).
