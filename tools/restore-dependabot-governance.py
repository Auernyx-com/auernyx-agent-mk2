#!/usr/bin/env python3
"""
Dependabot Governance Restoration Tool

This tool generates retroactive intent files for merged Dependabot PRs that
bypassed governance controls. It creates properly formatted intent JSON files
marked as closed with governanceBreach amendments.

Usage:
  python3 tools/restore-dependabot-governance.py
  python3 tools/restore-dependabot-governance.py --dry-run
  python3 tools/restore-dependabot-governance.py --commit <sha>
"""

import argparse
import json
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import os


REPO_ROOT = Path(__file__).resolve().parents[1]
INTENT_DIR = REPO_ROOT / "governance" / "alteration-program" / "intent"

# Default runtime path prefixes for this repository's layout.
# These are intentionally project-specific but can be overridden by setting
# the DEPENDABOT_RUNTIME_PREFIXES environment variable to a comma-separated list,
# e.g. "src/,core/,capabilities/,clients/".
_default_runtime_prefixes: Tuple[str, ...] = ("src/", "core/", "capabilities/", "clients/")
_env_runtime_prefixes = os.getenv("DEPENDABOT_RUNTIME_PREFIXES")
if _env_runtime_prefixes:
    RUNTIME_PREFIXES: Tuple[str, ...] = tuple(
        prefix.strip() for prefix in _env_runtime_prefixes.split(",") if prefix.strip()
    )
else:
    RUNTIME_PREFIXES = _default_runtime_prefixes


def run_cmd(cmd: List[str], cwd: Optional[Path] = None, check: bool = True) -> Tuple[str, int]:
    """Run a command and return stdout and return code."""
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False
        )
        return result.stdout.strip(), result.returncode
    except Exception as e:
        if check:
            raise
        return str(e), 1


def generate_intent_id() -> str:
    """Generate a properly formatted intentId: 13digits-8hex."""
    timestamp_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    random_hex = secrets.token_hex(4)  # 8 hex chars
    return f"{timestamp_ms}-{random_hex}"


def classify_dependency_change(package: str, changed_files: List[str]) -> Tuple[str, str]:
    """
    Classify dependency changes.

    Returns (changeClass, riskClass)

    Dependency updates are typically leaf changes (they don't modify architecture),
    but major version bumps or updates impacting runtime paths carry higher risk.
    """
    # Check if this is a dev dependency or production dependency.
    # We intentionally use a heuristic based on common JS/TS tooling packages so we
    # don't need to parse package.json but still avoid hardcoding a tiny list.
    dev_dep_prefixes = (
        "@types/",
        "eslint-config-",
        "eslint-plugin-",
        "babel-",
    )
    dev_dep_names = {
        "typescript",
        "ts-node",
        "ts-jest",
        "ts-loader",
        "eslint",
        "prettier",
        "jest",
        "vitest",
        "mocha",
        "chai",
        "nyc",
        "webpack",
        "rollup",
        "vite",
        "babel",
        "babel-cli",
        "babel-core",
        "babel-loader",
        "lint-staged",
        "husky",
        "nodemon",
    }
    is_dev_dep = (
        "@types" in package
        or package in dev_dep_names
        package in dev_dep_names
        or any(package.startswith(prefix) for prefix in dev_dep_prefixes)
    )

    # Dependency updates are leaf changes (don't affect architecture)
    # unless they're core runtime dependencies
    if is_dev_dep:
        return "leaf", "low"

    # For production dependencies, raise risk if the change appears to touch runtime code.
    # We intentionally use a simple heuristic based on common runtime directories so we
    # don't need to know the full project layout. The prefixes are defined at module
    # level (RUNTIME_PREFIXES) and are specific to this repository's structure.
    touches_runtime = any(
        any(path.startswith(prefix) for prefix in RUNTIME_PREFIXES)
        for path in changed_files or []
    )

    if touches_runtime:
        return "leaf", "medium"

    # Production dependencies that only touch non-runtime files (e.g. lockfiles) stay low risk
    return "leaf", "low"


def generate_retroactive_intent(commit_sha: str, commit_info: Dict, dep_info: Dict) -> Dict:
    """Generate a retroactive intent file for a Dependabot commit."""
    intent_id = generate_intent_id()
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    now_date_iso = now.date().isoformat()
    
    # Classify the change
    change_class, risk_class = classify_dependency_change(
        dep_info.get("package", ""),
        commit_info.get("changed_files", [])
    )
    
    # Build scope
    scope = {
        "in": [
            f"Dependency update: {dep_info['package']}",
            f"Version: {dep_info['from_version']} → {dep_info['to_version']}",
            "Automated Dependabot dependency bump"
        ],
        "out": [
            "No code logic changes",
            "No governance infrastructure changes",
            "No capability modifications"
        ]
    }
    
    # Build evidence notes
    evidence_notes = f"""RETROACTIVE INTENT - GOVERNANCE BREACH REMEDIATION

This intent file was created retroactively for a Dependabot commit that merged
without governance approval due to a bypass in the mk2-alteration-gate workflow.

Original Commit: {commit_info['sha']}
Commit Date: {commit_info['commit_date']}
PR Number: #{dep_info['pr_number']}
Merged By: {commit_info['author_name']} <{commit_info['author_email']}>

Dependency Update:
- Package: {dep_info['package']}
- From: {dep_info['from_version']}
- To: {dep_info['to_version']}

Files Changed:
"""
    
    for f in commit_info['changed_files'][:20]:
        evidence_notes += f"\n- {f}"
    
    if len(commit_info['changed_files']) > 20:
        evidence_notes += f"\n... and {len(commit_info['changed_files']) - 20} more files"
    
    # Truncate if too long (max 2000 chars per schema)
    # Check length after all evidence_notes content is added
    if len(evidence_notes) > 2000:
        evidence_notes = evidence_notes[:1997] + "..."
    
    # Build intent
    intent = {
        "intentId": intent_id,
        "title": commit_info['subject'][:160],  # Truncate to max length
        "system": "auernyx-agent-mk2",
        "changeClass": change_class,
        "scope": scope,
        "riskClass": risk_class,
        "governanceImpact": False,  # Dependency updates don't change governance
        "actorId": "dependabot-restoration",
        "createdAt": now_iso,
        "status": "closed",  # Mark as closed since it's already merged
        "verification": {
            "plan": f"Retroactive intent for merged Dependabot PR #{dep_info['pr_number']}. Dependency update was reviewed and merged.",
            "requiredChecks": [
                "mk2-alteration-gate"
            ]
        },
        "evidence": {
            "required": False,
            "receiptRefs": [],
            "notes": evidence_notes
        },
        "amendments": [
            {
                "amendedAt": datetime.now(timezone.utc).isoformat(),
                "actorId": f"governance-restoration-{datetime.now(timezone.utc).date().isoformat()}",
                "amendedAt": now_iso,
                "actorId": f"governance-restoration-{now_date_iso}",
                "reason": "Retroactive intent creation due to governance breach. Dependabot bypass removed from alteration gate.",
                "fieldsChanged": ["status", "createdAt", "evidence.notes"]
            }
        ]
    }
    
    return intent


def save_intent(intent: Dict, output_path: Optional[Path] = None) -> Path:
    """Save intent JSON to file."""
    if output_path is None:
        filename = f"{intent['intentId']}.json"
        output_path = INTENT_DIR / filename
    
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(intent, f, indent=2, ensure_ascii=False)
        f.write('\n')  # Add trailing newline
    
    return output_path


def restore_governance(audit_result: Dict, dry_run: bool = False) -> List[Dict]:
    """Generate retroactive intent files for all ungoverned commits."""
    created_intents = []
    
    for entry in audit_result['commits']:
        commit_info = entry['commit']
        dep_info = entry['dependency']
        
        print(f"Generating intent for commit {commit_info['short_sha']}...", file=sys.stderr)
        
        intent = generate_retroactive_intent(
            commit_info['sha'],
            commit_info,
            dep_info
        )
        
        if dry_run:
            print(f"  [DRY RUN] Would create: {intent['intentId']}.json", file=sys.stderr)
            created_intents.append({
                "intent_id": intent['intentId'],
                "commit": commit_info['short_sha'],
                "package": dep_info['package'],
                "pr": dep_info['pr_number']
            })
        else:
            output_path = save_intent(intent)
            print(f"  ✓ Created: {output_path.relative_to(REPO_ROOT)}", file=sys.stderr)
            created_intents.append({
                "intent_id": intent['intentId'],
                "path": str(output_path.relative_to(REPO_ROOT)),
                "commit": commit_info['short_sha'],
                "package": dep_info['package'],
                "pr": dep_info['pr_number']
            })
    
    return created_intents


def main():
    parser = argparse.ArgumentParser(
        description="Generate retroactive intent files for ungoverned Dependabot commits"
    )
    
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be created without creating files"
    )
    
    parser.add_argument(
        "--audit-file",
        help="Path to audit JSON file (default: run audit now)"
    )
    
    args = parser.parse_args()
    
    # Get audit results
    if args.audit_file:
        print(f"Loading audit results from {args.audit_file}...", file=sys.stderr)
        with open(args.audit_file, 'r') as f:
            audit_result = json.load(f)
    else:
        # Run audit using the audit-dependabot.py script
        print("Running audit to find ungoverned commits...", file=sys.stderr)
        audit_script = REPO_ROOT / "tools" / "audit-dependabot.py"
        cmd = ["python3", str(audit_script), "--format", "json"]
        output, rc = run_cmd(cmd, check=False)
        
        # Note: audit script exits with 1 if violations found, which is expected
        if not output:
            print("Error: Audit script produced no output", file=sys.stderr)
            print(f"Return code: {rc}", file=sys.stderr)
            print("Try running: python3 tools/audit-dependabot.py --format json", file=sys.stderr)
            return 1
        
        try:
            audit_result = json.loads(output)
        except json.JSONDecodeError as e:
            print(f"Error: Failed to parse audit output: {e}", file=sys.stderr)
            return 1
    
    if audit_result['ungoverned_commits'] == 0:
        print("\n✓ No ungoverned commits found. Governance is intact.", file=sys.stderr)
        return 0
    
    print(f"\nFound {audit_result['ungoverned_commits']} ungoverned commit(s).", file=sys.stderr)
    print("Generating retroactive intent files...\n", file=sys.stderr)
    
    # Generate intent files
    created_intents = restore_governance(audit_result, dry_run=args.dry_run)
    
    # Print summary
    print("\n" + "=" * 80, file=sys.stderr)
    print("GOVERNANCE RESTORATION SUMMARY", file=sys.stderr)
    print("=" * 80, file=sys.stderr)
    
    if args.dry_run:
        print("\n[DRY RUN MODE - No files created]", file=sys.stderr)
    
    print(f"\nRetroactive intents generated: {len(created_intents)}", file=sys.stderr)
    
    for intent_info in created_intents:
        print(f"\n  Intent ID: {intent_info['intent_id']}", file=sys.stderr)
        print(f"  Commit: {intent_info['commit']}", file=sys.stderr)
        print(f"  Package: {intent_info['package']}", file=sys.stderr)
        print(f"  PR: #{intent_info['pr']}", file=sys.stderr)
        if not args.dry_run:
            print(f"  File: {intent_info['path']}", file=sys.stderr)
    
    if not args.dry_run:
        print("\n✓ Governance restored. Intent files created.", file=sys.stderr)
        print("\nNext steps:", file=sys.stderr)
        print("  1. Review the generated intent files", file=sys.stderr)
        print("  2. Commit them to the repository", file=sys.stderr)
        print("  3. The governance breach is now documented in the audit trail", file=sys.stderr)
    
    print()
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
