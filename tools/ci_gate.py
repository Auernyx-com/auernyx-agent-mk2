#!/usr/bin/env python3
import json, os, re, subprocess
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

def run(cmd, cwd: Path | None = None):
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(cmd)}\n{p.stderr.strip()}")
    return p.stdout

def git_root() -> Path:
    out = run(["git", "-C", str(REPO_ROOT), "rev-parse", "--show-toplevel"]).strip()
    return Path(out)

def repo_prefix(groot: Path) -> str:
    rel = os.path.relpath(str(REPO_ROOT), str(groot))
    if rel == ".":
        return ""
    return rel.replace("\\", "/").rstrip("/") + "/"

GIT_ROOT = git_root()
PREFIX = repo_prefix(GIT_ROOT)

AUTH_RECORD_DIR = f"{PREFIX}governance/alteration-program/authorization/records"
ALLOWLIST_PATH = REPO_ROOT / "governance/alteration-program/authorization/allowlist.json"

# Dependabot PRs (2026-11-27): authorized by a live allowlisted approval, not
# a record commit on Dependabot's branch (any foreign push there stalls checks
# and makes Dependabot stop managing the PR). The record is filed right after
# the merge as records/<date>-dependabot-pr-<N>.json (tools/open-pr.sh does it),
# and every non-Dependabot PR is blocked until it is. Merges before this date
# predate the rule (they got record commits the old way).
DEPENDABOT_AUTHOR = "dependabot[bot]"
DEPENDABOT_RECORD_SINCE = "2026-11-27"
MANIFEST_FILES = {f"{PREFIX}package.json", f"{PREFIX}package-lock.json"}
BACKFILL_NAME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-dependabot-pr-(\d+)\.json$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
PR_SUFFIX_RE = re.compile(r"\(#(\d+)\)\s*$")

GITHUB_LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")

def fail(msg: str) -> None:
    raise SystemExit(f"Fail-closed: {msg}")

TRACE_FILES = [
    "governance/alteration-program/logs/update_apply.ndjson",
    "governance/alteration-program/logs/bastion_secondary.ndjson",
    "governance/alteration-program/logs/ui_actions.ndjson",
]

def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def get_changed_files(base_ref):
    diff = run(["git", "-C", str(GIT_ROOT), "diff", "--name-only", f"{base_ref}...HEAD"])
    return [f.strip() for f in diff.splitlines() if f.strip()]

def get_working_files():
    staged = run(["git", "-C", str(GIT_ROOT), "diff", "--name-only", "--cached"])
    staged_files = [f.strip() for f in staged.splitlines() if f.strip()]
    if staged_files:
        return staged_files, "staged"

    wt = run(["git", "-C", str(GIT_ROOT), "diff", "--name-only"])
    wt_files = [f.strip() for f in wt.splitlines() if f.strip()]
    return wt_files, "working"

def get_changed_auth_records(files):
    prefix = AUTH_RECORD_DIR + "/"
    return [f for f in files if f.startswith(prefix) and f.endswith(".json")]

def record_introducing_commit(record_path: str) -> str:
    return run(["git", "-C", str(GIT_ROOT), "log", "-1", "--format=%H", "--", record_path]).strip()

def validate_auth_record(record_path: str) -> None:
    full_path = GIT_ROOT / record_path
    try:
        record = load_json(full_path)
    except Exception as e:
        fail(f"could not parse authorization record {record_path}: {e}")

    for field in ("authorizedBy", "authorizedAt", "reason"):
        if field not in record:
            fail(f"authorization record missing required field '{field}' in {record_path}")

    authorized_by = record["authorizedBy"]
    if not isinstance(authorized_by, str) or not GITHUB_LOGIN_RE.match(authorized_by):
        fail(f"authorizedBy must be a valid GitHub login (got {authorized_by!r}) in {record_path}")

    authorized_at = record["authorizedAt"]
    if not isinstance(authorized_at, str):
        fail(f"authorizedAt must be an ISO date string YYYY-MM-DD (got {authorized_at!r}) in {record_path}")
    try:
        parsed_date = date.fromisoformat(authorized_at)
    except ValueError:
        fail(f"authorizedAt must be a valid ISO date string YYYY-MM-DD (got {authorized_at!r}) in {record_path}")
    if parsed_date > date.today():
        fail(f"authorizedAt must not be a future date (got {authorized_at!r}) in {record_path}")

    if not isinstance(record.get("reason"), str) or not record["reason"].strip():
        fail(f"reason must be a non-empty string in {record_path}")

    if not ALLOWLIST_PATH.exists():
        fail(f"allowlist not found at {ALLOWLIST_PATH}")
    try:
        allowlist = load_json(ALLOWLIST_PATH)
    except Exception as e:
        fail(f"could not parse allowlist {ALLOWLIST_PATH}: {e}")

    allowed_logins = allowlist.get("authorizedLogins", [])
    if authorized_by not in allowed_logins:
        fail(f"authorizedBy '{authorized_by}' is not in the allowlist ({ALLOWLIST_PATH}). authorizedLogins: {allowed_logins}")

    # Independent-audit finding (2026-09-07, round 8, critical, found via
    # SQUAD's independent audit of this same pattern -- see SQUAD#69): every
    # check above only validates the record's OWN fields -- none of it
    # verifies the record was actually produced by the real auto-authorize
    # job rather than a hand-written file. A forged record with a
    # valid-looking authorizedBy/authorizedAt/reason, committed as part of
    # an attacker's own PR (no real review, no real approval), passed every
    # check above with no exception -- a complete bypass of the allowlist
    # model. Fixed by requiring the commit that introduced this exact
    # record file to match a SHA the auto-authorize job vouches for via
    # MK2_RECORD_COMMIT_SHA -- a GitHub Actions job output populated only
    # when that job's own live, this-run GitHub API-based is_allowed check
    # was true. An attacker's own PR-branch commit can claim any git author
    # identity it wants (spoofable locally), but cannot inject a value into
    # another job's output.
    trusted_sha = os.environ.get("MK2_RECORD_COMMIT_SHA", "").strip()
    if not trusted_sha:
        fail(
            f"no trusted record commit reported by auto-authorize for {record_path} "
            f"(MK2_RECORD_COMMIT_SHA is empty) -- refusing to trust a record this run "
            f"cannot verify was produced by the real authorization job"
        )
    actual_sha = record_introducing_commit(record_path)
    if actual_sha != trusted_sha:
        fail(
            f"{record_path} was introduced by commit {actual_sha!r}, which does not match "
            f"the commit auto-authorize vouched for ({trusted_sha!r}) -- this record was not "
            f"verifiably created by the real authorization job"
        )

def is_backfill_record(path: str) -> bool:
    return BACKFILL_NAME_RE.match(os.path.basename(path)) is not None

def load_allowlist() -> list[str]:
    if not ALLOWLIST_PATH.exists():
        fail(f"allowlist not found at {ALLOWLIST_PATH}")
    try:
        return load_json(ALLOWLIST_PATH).get("authorizedLogins", [])
    except Exception as e:
        fail(f"could not parse allowlist {ALLOWLIST_PATH}: {e}")

def validate_backfill_record(record_path: str) -> None:
    """Extra checks for an after-merge Dependabot record. The facts inside were
    re-derived from GitHub by auto-authorize (verifyBackfillRecord); this job
    has no API, so it requires that verification's job output."""
    m = BACKFILL_NAME_RE.match(os.path.basename(record_path))
    record = load_json(GIT_ROOT / record_path)
    if record.get("kind") != "dependabot-merge":
        fail(f"{record_path}: kind must be 'dependabot-merge'")
    if record.get("pullRequest") != int(m.group(1)):
        fail(f"{record_path}: pullRequest does not match the file name")
    if not isinstance(record.get("mergeCommit"), str) or not SHA_RE.match(record["mergeCommit"]):
        fail(f"{record_path}: mergeCommit must be a full commit SHA")
    if not isinstance(record.get("approvalReviewId"), int):
        fail(f"{record_path}: approvalReviewId must be an integer")
    if record.get("approvedBy") not in load_allowlist():
        fail(f"{record_path}: approvedBy {record.get('approvedBy')!r} is not in the allowlist")
    if os.environ.get("MK2_BACKFILL_VERIFIED", "").strip() != "true":
        fail(
            f"{record_path}: auto-authorize did not verify this Dependabot record against GitHub "
            f"(MK2_BACKFILL_VERIFIED is not 'true') -- refusing to trust it"
        )

def recorded_dependabot_prs() -> set[int]:
    rec_dir = GIT_ROOT / AUTH_RECORD_DIR
    found: set[int] = set()
    if rec_dir.exists():
        for p in rec_dir.iterdir():
            m = BACKFILL_NAME_RE.match(p.name)
            if m:
                found.add(int(m.group(1)))
    return found

def unrecorded_dependabot_merges(ref: str) -> list[tuple[int, str, str]]:
    """Dependabot squash merges on `ref`'s first-parent line since the rule
    started, with no records/*-dependabot-pr-<N>.json in the working tree."""
    out = run([
        "git", "-C", str(GIT_ROOT), "log", "--first-parent",
        f"--author={re.escape(DEPENDABOT_AUTHOR)}",
        f"--since={DEPENDABOT_RECORD_SINCE}T00:00:00Z",
        "--format=%H%x09%s", ref,
    ])
    recorded = recorded_dependabot_prs()
    missing = []
    for line in out.splitlines():
        if not line.strip():
            continue
        sha, _, subject = line.partition("\t")
        m = PR_SUFFIX_RE.search(subject)
        if not m:
            fail(f"Dependabot commit {sha[:7]} on {ref} has no (#PR) suffix -- cannot tell which PR it records")
        n = int(m.group(1))
        if n not in recorded:
            missing.append((n, sha, subject))
    return missing

def assert_dependabot_merges_recorded(ref: str) -> None:
    missing = unrecorded_dependabot_merges(ref)
    if missing:
        listed = "; ".join(f"#{n} ({sha[:7]} {subj})" for n, sha, subj in missing)
        fail(
            f"Dependabot merge(s) on main have no AVRS record yet: {listed}. "
            f"Open this PR with tools/open-pr.sh -- it files the record(s) from GitHub."
        )

def dependabot_gate(files: list[str]) -> None:
    """A Dependabot PR: authorized only by the approval the dependabot-approval
    job verified live this run (its output, not anything on the branch)."""
    approved_by = os.environ.get("MK2_DEPENDABOT_APPROVED_BY", "").strip()
    if not approved_by:
        reason = os.environ.get("MK2_DEPENDABOT_REASON", "").strip() or "no allowlisted approval"
        fail(f"Dependabot PR not authorized: {reason}")
    if approved_by not in load_allowlist():
        fail(f"Dependabot approval by {approved_by!r}, who is not in the allowlist")
    extra = [f for f in files if f not in MANIFEST_FILES]
    if extra:
        fail(f"Dependabot PR may change only package.json/package-lock.json; also changes: {extra}")
    print(f"Mk2 Alteration Gate: PASS (Dependabot update approved by {approved_by}; "
          f"AVRS record is filed after merge, see job summary)")

def assert_updates_inbox_clean() -> None:
    inbox = REPO_ROOT / "updates" / "incoming"
    if not inbox.exists():
        return

    allowed = {".gitkeep"}
    offenders: list[str] = []
    for p in inbox.rglob("*"):
        if p.is_dir():
            continue
        if p.name in allowed:
            continue
        offenders.append(str(p.relative_to(REPO_ROOT)).replace("\\", "/"))

    if offenders:
        fail("updates/incoming must not contain committed payload files; offenders: " + ", ".join(offenders))

def assert_no_nested_updates_updates() -> None:
    nested = REPO_ROOT / "updates" / "updates"
    if nested.exists():
        fail("illegal nested path exists: updates/updates")

def assert_append_only_trace_files(changed_files: list[str], base_ref: str | None) -> None:
    def normalize_newlines(data: bytes) -> bytes:
        # Avoid false positives across OSes/editors. Compare using LF newlines.
        data = data.replace(b"\r\n", b"\n")
        data = data.replace(b"\r", b"\n")
        return data

    changed = {f.replace("\\", "/") for f in changed_files}
    for rel in TRACE_FILES:
        rel_norm = (PREFIX + rel).replace("\\", "/")
        if rel_norm not in changed:
            continue

        new_path = (GIT_ROOT / rel_norm)
        if not new_path.exists():
            fail(f"trace file marked changed but missing on disk: {rel_norm}")

        new_bytes = normalize_newlines(new_path.read_bytes())
        if base_ref:
            try:
                base_text = run(["git", "-C", str(GIT_ROOT), "show", f"{base_ref}:{rel_norm}"])
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception:
                base_text = ""
        else:
            try:
                base_text = run(["git", "-C", str(GIT_ROOT), "show", f"HEAD:{rel_norm}"])
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception:
                base_text = ""

        base_bytes = normalize_newlines(base_text.encode("utf-8", errors="replace"))
        if base_bytes and not new_bytes.startswith(base_bytes):
            fail(f"trace file must be append-only (base content must be a prefix): {rel_norm}")

def main():
    assert_no_nested_updates_updates()
    assert_updates_inbox_clean()

    base_ref = os.environ.get("MK2_BASE_REF", "").strip()
    if base_ref:
        files = get_changed_files(base_ref)
        source = f"commit-diff:{base_ref}...HEAD"
        append_only_base = base_ref
    else:
        files, source = get_working_files()
        append_only_base = None

    if os.environ.get("MK2_IS_DEPENDABOT_PR", "").strip() == "true":
        dependabot_gate(files)
        return

    if not files:
        print("Mk2 Alteration Gate: PASS (no-op diff, zero changes)")
        return

    assert_append_only_trace_files(files, append_only_base)
    assert_dependabot_merges_recorded(base_ref or "HEAD")

    auth_records = get_changed_auth_records(files)
    if not [r for r in auth_records if not is_backfill_record(r)]:
        raise SystemExit(
            f"Fail-closed: must change/add at least ONE authorization record under "
            f"{AUTH_RECORD_DIR}/ (from {source}). Dependabot after-merge records "
            f"don't count as this PR's own authorization. "
            f"Found: {auth_records}"
        )

    for record in auth_records:
        validate_auth_record(record)
        if is_backfill_record(record):
            validate_backfill_record(record)

    print("Mk2 Alteration Gate: PASS")

if __name__ == "__main__":
    import sys
    if sys.argv[1:2] == ["--list-unrecorded-dependabot"]:
        # Used by tools/backfill-dependabot-records.js: one PR number per line.
        ref = sys.argv[2] if len(sys.argv) > 2 else "origin/main"
        for n, _sha, _subj in unrecorded_dependabot_merges(ref):
            print(n)
    else:
        main()
