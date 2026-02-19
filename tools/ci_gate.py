#!/usr/bin/env python3
import json, os, re, subprocess
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

INTENT_DIR = f"{PREFIX}governance/alteration-program/intent"
SCHEMA_PATH = f"{PREFIX}governance/alteration-program/schema/intent.schema.json"

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

def get_changed_intents(files):
    return [f for f in files if f.startswith(INTENT_DIR + "/") and f.endswith(".json")]

def invariant_checks(intent):
    if not re.match(r"^[0-9]{13}-[a-f0-9]{8}$", intent.get("intentId","")):
        raise SystemExit("Fail-closed: intentId must match 13digits-8hex.")
    if intent.get("changeClass") not in {"root","trunk","branch","leaf"}:
        raise SystemExit("Fail-closed: invalid changeClass.")
    if intent.get("riskClass") not in {"low","medium","high"}:
        raise SystemExit("Fail-closed: invalid riskClass.")
    if intent.get("status") not in {"draft","in_review","approved","closed","deferred"}:
        raise SystemExit("Fail-closed: invalid status.")
    scope = intent.get("scope", {})
    if not isinstance(scope.get("in"), list) or len(scope["in"]) < 1:
        raise SystemExit("Fail-closed: scope.in must be non-empty.")
    if not isinstance(scope.get("out"), list):
        raise SystemExit("Fail-closed: scope.out must be a list.")
    if intent.get("governanceImpact") is True and intent.get("evidence", {}).get("required") is not True:
        raise SystemExit("Fail-closed: governanceImpact=true requires evidence.required=true.")

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
        allow_closed_intent_check = True
        append_only_base = base_ref
    else:
        files, source = get_working_files()
        allow_closed_intent_check = False
        append_only_base = None

    assert_append_only_trace_files(files, append_only_base)

    intents = get_changed_intents(files)
    if len(intents) != 1:
        raise SystemExit(f"Fail-closed: must change/add exactly ONE intent under {INTENT_DIR} (from {source}). Found: {intents}")

    intent_path = intents[0]
    intent = load_json(GIT_ROOT / intent_path)

    schema = load_json(GIT_ROOT / SCHEMA_PATH)
    for k in schema.get("required", []):
        if k not in intent:
            raise SystemExit(f"Fail-closed: intent missing required field: {k}")

    invariant_checks(intent)

    expected = os.path.join(INTENT_DIR, f"{intent['intentId']}.json").replace("\\","/")
    if intent_path.replace("\\","/") != expected:
        raise SystemExit(f"Fail-closed: filename must match intentId. Expected {expected}, got {intent_path}")

    # if closed intent existed at base, modifications require a new amendment entry
    if allow_closed_intent_check:
        p = subprocess.run(
            ["git", "-C", str(GIT_ROOT), "show", f"{base_ref}:{intent_path}"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        if p.returncode != 0:
            stderr_lower = p.stderr.lower()
            if "does not exist" in stderr_lower or "exists on disk" in stderr_lower:
                # New intent file — not present at base, allowed to proceed
                pass
            else:
                fail(
                    f"Could not retrieve base intent at '{base_ref}:{intent_path}' "
                    f"(git exit {p.returncode}: {p.stderr.strip()}). "
                    "Verify that MK2_BASE_REF is correct and the intent file path is valid."
                )
        else:
            try:
                base_intent = json.loads(p.stdout)
            except json.JSONDecodeError as e:
                fail(
                    f"Failed to parse base intent JSON at '{base_ref}:{intent_path}': {e}. "
                    "The intent file at the base ref must be valid JSON."
                )
            if base_intent.get("status") == "closed":
                base_am = base_intent.get("amendments", []) or []
                new_am = intent.get("amendments", []) or []
                if len(new_am) <= len(base_am):
                    fail(
                        "Modifying a closed intent requires adding a new amendments[] entry. "
                        "Add an entry to the amendments[] array in the intent file documenting this change."
                    )

    print("Mk2 Alteration Gate: PASS")

if __name__ == "__main__":
    main()
