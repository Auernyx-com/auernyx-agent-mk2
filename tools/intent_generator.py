#!/usr/bin/env python3
"""
Generate a governance intent file for a Dependabot (or automated) commit.

Usage:
    python3 tools/intent_generator.py --commit <sha> --actor-id <str>

Writes:
    governance/alteration-program/intent/<intentId>.json
"""

import argparse
import hashlib
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
INTENT_DIR = REPO_ROOT / "governance" / "alteration-program" / "intent"

# Path classification for risk + layer determination
GOVERNANCE_PATHS  = ["governance/", ".github/workflows/"]
CORE_PATHS        = ["core/", "src/core/"]
TOOLS_PATHS       = ["tools/", "clients/"]
DEPENDENCY_FILES  = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
                     "requirements.txt", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
                     ".github/dependabot.yml"]


def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(cmd)}\n{r.stderr.strip()}")
    return r.stdout


def get_changed_files(commit_sha: str) -> list[str]:
    diff = run(["git", "diff-tree", "--no-commit-id", "-r", "--name-only", commit_sha])
    return [f.strip() for f in diff.splitlines() if f.strip()]


def classify(files: list[str]) -> tuple[str, str, bool]:
    """Returns (changeClass, riskClass, governanceImpact)."""
    governance_touched = any(
        any(f.startswith(p) for p in GOVERNANCE_PATHS) for f in files
    )
    core_touched = any(
        any(f.startswith(p) for p in CORE_PATHS) for f in files
    )
    tools_touched = any(
        any(f.startswith(p) for p in TOOLS_PATHS) for f in files
    )
    dep_touched = any(
        any(f == d or f.endswith("/" + d) for d in DEPENDENCY_FILES) for f in files
    )

    # changeClass: governance files → trunk, core/ → branch, deps/tools → leaf
    if governance_touched:
        change_class = "trunk"
    elif core_touched:
        change_class = "branch"
    else:
        change_class = "leaf"

    # riskClass
    if governance_touched:
        risk_class = "medium"
    elif core_touched:
        risk_class = "medium"
    else:
        risk_class = "low"

    return change_class, risk_class, governance_touched


def build_title(files: list[str], actor_id: str) -> str:
    dep_files = [f for f in files if any(f.endswith(d) for d in ["package.json", "package-lock.json",
                 "yarn.lock", "requirements.txt", "Cargo.toml", "go.mod"])]
    if dep_files:
        names = [Path(f).name for f in dep_files[:2]]
        suffix = " and others" if len(dep_files) > 2 else ""
        return f"Automated dependency update: {', '.join(names)}{suffix}"
    return f"Automated update by {actor_id} ({len(files)} file(s) changed)"


def build_scope(files: list[str], change_class: str, governance_impact: bool) -> dict:
    scope_in = list(dict.fromkeys(
        str(Path(f).parent) if Path(f).parent != Path(".") else f
        for f in files
    )) or files

    out = ["No manual source logic changes"]
    if not governance_impact:
        out.append("No governance file changes")
    out.append("No API contract changes")

    return {"in": scope_in[:8], "out": out}


def make_intent_id() -> str:
    ts_ms = int(time.time() * 1000)
    rand_hex = hashlib.md5(f"{ts_ms}".encode()).hexdigest()[:8]
    return f"{ts_ms}-{rand_hex}"


def generate(commit_sha: str, actor_id: str) -> Path:
    INTENT_DIR.mkdir(parents=True, exist_ok=True)

    files = get_changed_files(commit_sha)
    if not files:
        raise SystemExit(f"No changed files found for commit {commit_sha}")

    change_class, risk_class, governance_impact = classify(files)
    intent_id = make_intent_id()
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    intent = {
        "intentId":        intent_id,
        "title":           build_title(files, actor_id),
        "system":          "dependency-management",
        "changeClass":     change_class,
        "scope":           build_scope(files, change_class, governance_impact),
        "riskClass":       risk_class,
        "governanceImpact": governance_impact,
        "actorId":         actor_id,
        "createdAt":       now,
        "status":          "draft",
        "verification": {
            "plan": (
                f"Automated dependency update for commit {commit_sha[:12]}. "
                f"Changed files: {', '.join(files[:5])}"
                + (f" (+{len(files)-5} more)" if len(files) > 5 else "") +
                ". Verify CI checks pass and no governance paths are unexpectedly modified."
            ),
            "requiredChecks": ["mk2-alteration-gate", "typescript-compile"],
        },
        "evidence": {
            "required":   governance_impact,
            "receiptRefs": [],
            "notes": (
                f"Auto-generated intent for {actor_id} commit {commit_sha}.\n"
                f"Changed files ({len(files)}): {', '.join(files)}.\n"
                f"Governance paths touched: {governance_impact}."
            ),
        },
        "amendments": [],
    }

    out_path = INTENT_DIR / f"{intent_id}.json"
    out_path.write_text(json.dumps(intent, indent=2) + "\n", encoding="utf-8")
    print(f"Intent written: {out_path}")
    return out_path


def main():
    parser = argparse.ArgumentParser(description="Generate a governance intent file for an automated commit.")
    parser.add_argument("--commit",   required=True, help="Git commit SHA to inspect")
    parser.add_argument("--actor-id", required=True, help="Actor identifier for the intent record")
    args = parser.parse_args()

    commit_sha = args.commit.strip()
    if not re.match(r"^[0-9a-f]{7,40}$", commit_sha):
        raise SystemExit(f"Invalid commit SHA: {commit_sha!r}")

    generate(commit_sha, args.actor_id)


if __name__ == "__main__":
    main()
