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
            except BaseException:
                base_text = ""
        else:
            try:
                base_text = run(["git", "-C", str(GIT_ROOT), "show", f"HEAD:{rel_norm}"])
            except BaseException:
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

    assert_append_only_trace_files(files, append_only_base)

    auth_records = get_changed_auth_records(files)
    if len(auth_records) < 1:
        raise SystemExit(
            f"Fail-closed: must change/add at least ONE authorization record under "
            f"{AUTH_RECORD_DIR}/ (from {source}). "
            f"Found: {auth_records}"
        )

    for record in auth_records:
        validate_auth_record(record)

    print("Mk2 Alteration Gate: PASS")

if __name__ == "__main__":
    main()
