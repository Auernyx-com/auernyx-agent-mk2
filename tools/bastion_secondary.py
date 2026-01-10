#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    p = subprocess.run(cmd, cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, (p.stdout or "")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_last_nonempty_line(path: Path) -> str | None:
    if not path.exists():
        return None
    data = path.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in reversed(data):
        if line.strip():
            return line
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="Repo root")
    ap.add_argument("--actor", default=os.environ.get("USERNAME", "unknown"))
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    log_dir = repo / "governance" / "alteration-program" / "logs"
    apply_log = log_dir / "update_apply.ndjson"
    bastion_ndjson = log_dir / "bastion_secondary.ndjson"
    bastion_json = log_dir / "bastion_secondary.json"

    log_dir.mkdir(parents=True, exist_ok=True)
    apply_log.touch(exist_ok=True)

    last_line = read_last_nonempty_line(apply_log)
    if not last_line:
        raise SystemExit(
            "Fail-closed: No apply events found in governance/alteration-program/logs/update_apply.ndjson; "
            "run tools/mk2_momentum.ps1 after applying a payload."
        )

    try:
        last_apply = json.loads(last_line)
    except Exception as e:
        raise SystemExit(f"Fail-closed: Could not parse last apply event JSON line: {e}")
    last_apply_sha256 = sha256_text(last_line)

    # Mk2 gate must pass (fail-closed)
    code, out = run(["python", str(repo / "tools" / "ci_gate.py")], cwd=repo)
    mk2_gate = "PASS" if code == 0 else "FAIL"
    if code != 0:
        raise SystemExit("Fail-closed: mk2 gate failed:\n" + out.strip())

    # Git binding (best effort but should normally exist)
    code2, head = run(["git", "rev-parse", "HEAD"], cwd=repo)
    head_commit = head.strip() if code2 == 0 else "unknown"
    code3, branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo)
    branch_name = branch.strip() if code3 == 0 else "unknown"

    obj = {
        "event": "bastion_secondary_check",
        "checkedAt": utc_now(),
        "branch": branch_name,
        "headCommit": head_commit,
        "mk2Gate": mk2_gate,
        "lastApply": {
            "payloadId": last_apply.get("payloadId"),
            "intentId": last_apply.get("intentId"),
            "manifestSha256": last_apply.get("manifestSha256"),
            "applyEventSha256": last_apply_sha256,
        },
    }

    bastion_json.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with bastion_ndjson.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")

    # Print a single-line JSON for callers to capture.
    print(json.dumps(obj, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
