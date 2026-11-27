#!/usr/bin/env bash
# Open a PR to main with the authorization record already in it.
#
# Why: if the record is missing, mk2-alteration-gate's auto-authorize job
# pushes it as github-actions[bot]. GitHub never starts check runs for a push
# made with the built-in token, so the bot's commit becomes the PR head with
# no `test` / `kotlin-proof` / CodeQL, and the PR sits BLOCKED until someone
# pushes an extra empty commit. Committing the record yourself, in the first
# push, means the bot finds a record and pushes nothing; your commit stays the
# head and every required check runs normally.
#
# This does NOT bypass the gate. ci_gate.py trusts the record only when
# auto-authorize, on that run, recomputes live from GitHub that the PR author
# is on the allowlist or an allowlisted login approved it. A record written
# by anyone else still fails. No secrets involved.
#
# Usage: tools/open-pr.sh "<PR title>" [body-file]
#   Run from the feature branch, with all work committed.
set -euo pipefail

TITLE="${1:-}"
BODY_FILE="${2:-}"
if [ -z "$TITLE" ]; then
  echo "usage: tools/open-pr.sh \"<PR title>\" [body-file]" >&2
  exit 2
fi
if [ -n "$BODY_FILE" ] && [ ! -f "$BODY_FILE" ]; then
  echo "body file not found: $BODY_FILE" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"
RECORD_DIR="governance/alteration-program/authorization/records"
ALLOWLIST="governance/alteration-program/authorization/allowlist.json"

BRANCH="$(git symbolic-ref --short HEAD)"
if [ "$BRANCH" = "main" ]; then
  echo "refusing: you are on main. Make a branch first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: uncommitted changes. Commit (or stash) them first." >&2
  exit 1
fi

LOGIN="$(gh api user -q .login)"
python3 - "$ALLOWLIST" "$LOGIN" <<'PY'
import json, sys
logins = json.load(open(sys.argv[1], encoding="utf-8")).get("authorizedLogins", [])
if sys.argv[2] not in logins:
    sys.exit(f"refusing: {sys.argv[2]!r} is not in the allowlist {logins}. "
             "Open the PR normally; an allowlisted approval authorizes it.")
PY

git fetch -q origin main
EXISTING="$(git diff --name-only origin/main...HEAD | grep -E "^${RECORD_DIR}/.*\.json$" || true)"
if [ -n "$EXISTING" ]; then
  echo "authorization record already on this branch: $EXISTING"
else
  # UTC date: ci_gate.py rejects a future authorizedAt, and the runner is UTC.
  TODAY="$(date -u +%F)"
  SLUG="$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9._-' '-' | tr -s '-' | sed 's/^-//; s/-$//')"
  RECORD_FILE="${RECORD_DIR}/${TODAY}-branch-${SLUG}.json"
  python3 - "$RECORD_FILE" "$LOGIN" "$TODAY" "$BRANCH" "$TITLE" <<'PY'
import json, os, sys
path, login, today, branch, title = sys.argv[1:6]
name = os.path.basename(path)[:-5]
record = {
    "governance_record": name,
    "authorization_logic": f"{login} authorized via allowlist for branch {branch}: {title} (record committed by the author in the PR's first push, tools/open-pr.sh)",
    "signature": f"{login}-{today}-{branch}",
    "authorizedBy": login,
    "authorizedAt": today,
    "reason": f"{branch}: {title}",
    "branch": branch,
}
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(record, f, indent=2)
    f.write("\n")
print(f"wrote {path}")
PY
  git add "$RECORD_FILE"
  git commit -q -m "chore: add governance authorization for ${BRANCH}"
fi

git push -q -u origin HEAD
if [ -n "$BODY_FILE" ]; then
  gh pr create --base main --title "$TITLE" --body-file "$BODY_FILE"
else
  gh pr create --base main --title "$TITLE" --body ""
fi
