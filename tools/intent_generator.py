#!/usr/bin/env python3
"""
Intent Generator Tool

This tool helps generate intent JSON files for commits that failed the alteration gate
due to missing intent preparation. It can:
1. Analyze git history to find commits that modified files but lacked intent files
2. Generate properly formatted intent JSON files from commit metadata
3. Prepare intents for review and approval

Usage:
  python3 tools/intent_generator.py --commit <sha> --output <path>
  python3 tools/intent_generator.py --scan-failed-runs
  python3 tools/intent_generator.py --from-commit-message <sha>
"""

import argparse
import json
import os  # Reserved for future cross-platform path operations
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]
INTENT_DIR = REPO_ROOT / "governance" / "alteration-program" / "intent"
SCHEMA_PATH = REPO_ROOT / "governance" / "alteration-program" / "schema" / "intent.schema.json"


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
    import secrets
    timestamp_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    random_hex = secrets.token_hex(4)  # 8 hex chars
    return f"{timestamp_ms}-{random_hex}"


def get_commit_info(commit_sha: str) -> Optional[Dict]:
    """Extract metadata from a git commit."""
    # Get commit details
    cmd = ["git", "-C", str(REPO_ROOT), "show", "--no-patch", "--format=%H%n%an%n%ae%n%ai%n%s%n%b", commit_sha]
    output, rc = run_cmd(cmd, check=False)
    
    if rc != 0:
        print(f"Error: Could not find commit {commit_sha}", file=sys.stderr)
        return None
    
    lines = output.split('\n')
    if len(lines) < 5:
        print(f"Error: Unexpected git show output for {commit_sha}", file=sys.stderr)
        return None
    
    full_sha = lines[0]
    author_name = lines[1]
    author_email = lines[2]
    commit_date = lines[3]
    subject = lines[4]
    body = '\n'.join(lines[5:]) if len(lines) > 5 else ""
    
    # Get changed files
    cmd = ["git", "-C", str(REPO_ROOT), "diff-tree", "--no-commit-id", "--name-only", "-r", commit_sha]
    files_output, _ = run_cmd(cmd, check=False)
    changed_files = [f for f in files_output.split('\n') if f.strip()]
    
    # Get stats
    cmd = ["git", "-C", str(REPO_ROOT), "show", "--stat", "--format=", commit_sha]
    stats_output, _ = run_cmd(cmd, check=False)
    
    return {
        "sha": full_sha,
        "short_sha": full_sha[:8],
        "author_name": author_name,
        "author_email": author_email,
        "commit_date": commit_date,
        "subject": subject,
        "body": body,
        "changed_files": changed_files,
        "stats": stats_output
    }


def classify_change(commit_info: Dict) -> Tuple[str, str]:
    """
    Classify a change based on files modified.
    Returns (changeClass, riskClass)
    
    changeClass: root, trunk, branch, leaf
    riskClass: low, medium, high
    
    Note: Classification uses precedence order (root > trunk > branch > leaf).
    Files are checked against root patterns first, then trunk, then branch.
    If classification is unclear, the change is demoted to the next lower layer
    until a clear match is found or it defaults to leaf.
    """
    files = commit_info.get("changed_files", [])
    
    # Root changes: governance, core policy, schema (highest precedence)
    root_patterns = [
        "governance/alteration-program/schema/",
        "governance/contracts/",
        "governance/interfaces/",
        "core/policy.ts",
        "core/router.ts",
        "core/runLifecycle.ts"
    ]
    
    # Trunk changes: core modules, capabilities (exclude root files)
    trunk_patterns = [
        "core/",
        "capabilities/",
        "config/allowlist.json",
        "config/auernyx.config.json"
    ]
    
    # Branch changes: clients, workflows (exclude trunk/root)
    branch_patterns = [
        "clients/",
        ".github/workflows/",
        "tools/ci_gate.py"
    ]
    
    # Check patterns with precedence: root first (explicit files), then trunk, then branch
    # Root patterns are checked first and take precedence over broader patterns
    has_root = any(any(f.startswith(p) for p in root_patterns) for f in files)
    if has_root:
        # Clear root classification - governance schema, core policy/router
        return "root", "high"
    
    # Check trunk patterns (exclude already-classified root files)
    has_trunk = any(
        any(f.startswith(p) for p in trunk_patterns) and 
        not any(f.startswith(rp) for rp in root_patterns)
        for f in files
    )
    if has_trunk:
        # Clear trunk classification - core modules, capabilities
        return "trunk", "medium"
    
    # Check branch patterns
    has_branch = any(any(f.startswith(p) for p in branch_patterns) for f in files)
    if has_branch:
        # Clear branch classification - clients, CI workflows
        return "branch", "medium"
    
    # Default to leaf for unclear cases (documentation, tests, etc.)
    return "leaf", "low"


def infer_scope_from_commit(commit_info: Dict) -> Dict[str, List[str]]:
    """Infer scope from commit metadata."""
    files = commit_info.get("changed_files", [])
    subject = commit_info.get("subject", "")
    
    # Determine what's in scope
    in_scope = []
    
    # Try to extract from commit message
    if subject:
        in_scope.append(subject)
    
    # Add file categories
    file_categories = set()
    for f in files:
        if f.startswith("core/"):
            file_categories.add("Core governance modules")
        elif f.startswith("capabilities/"):
            file_categories.add("Capability implementations")
        elif f.startswith("clients/"):
            file_categories.add("Client interfaces")
        elif f.startswith(".github/"):
            file_categories.add("CI/CD workflows")
        elif f.startswith("docs/"):
            file_categories.add("Documentation")
        elif f.startswith("governance/"):
            file_categories.add("Governance infrastructure")
        elif f.startswith("tools/"):
            file_categories.add("Development tools")
    
    in_scope.extend(sorted(file_categories))
    
    # Default if nothing found
    if not in_scope:
        in_scope = ["Code changes from commit " + commit_info.get("short_sha", "unknown")]
    
    # Out of scope (reasonable defaults)
    out_scope = ["No contract or receipt format changes", "No policy enforcement logic changes"]
    
    return {
        "in": in_scope,
        "out": out_scope
    }


def truncate_title(title: str, max_length: int = 160) -> str:
    """Truncate title to max length, adding ellipsis if needed."""
    if len(title) <= max_length:
        return title
    return title[:max_length - 3] + "..."


def generate_intent_from_commit(commit_sha: str, actor_id: str = "intent-generator") -> Optional[Dict]:
    """Generate a complete intent JSON from a commit."""
    commit_info = get_commit_info(commit_sha)
    if not commit_info:
        return None
    
    intent_id = generate_intent_id()
    change_class, risk_class = classify_change(commit_info)
    scope = infer_scope_from_commit(commit_info)
    
    # Determine governance impact
    governance_files = ["governance/", "core/policy.ts", "core/router.ts", "config/allowlist.json"]
    governance_impact = any(
        any(f.startswith(gf) for gf in governance_files)
        for f in commit_info.get("changed_files", [])
    )
    
    # Build intent
    intent = {
        "intentId": intent_id,
        "title": truncate_title(commit_info["subject"]),
        "system": "auernyx-agent-mk2",
        "changeClass": change_class,
        "scope": scope,
        "riskClass": risk_class,
        "governanceImpact": governance_impact,
        "actorId": actor_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "draft",
        "verification": {
            "plan": f"Generated from commit {commit_info['short_sha']}. Review changes and run mk2-alteration-gate.",
            "requiredChecks": [
                "mk2-alteration-gate"
            ]
        },
        "evidence": {
            "required": governance_impact,
            "receiptRefs": [],
            "notes": f"Retroactive intent for commit {commit_info['sha']}\n\nFiles changed:\n" + "\n".join(f"- {f}" for f in commit_info['changed_files'][:10])
        },
        "amendments": []
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


def scan_for_missing_intents() -> List[str]:
    """
    Scan git history for commits that likely needed intents but don't have them.
    Returns list of commit SHAs.
    """
    # Get all commits that modified files outside of governance/alteration-program/intent/
    cmd = [
        "git", "-C", str(REPO_ROOT), "log",
        "--all",
        "--format=%H",
        "--",
        ".",
        ":(exclude)governance/alteration-program/intent/"
    ]
    
    output, rc = run_cmd(cmd, check=False)
    if rc != 0:
        return []
    
    all_commits = [line for line in output.split('\n') if line.strip()]
    
    # For each commit, check if there's a corresponding intent
    missing = []
    
    # Get all existing intents and extract referenced commits from their evidence
    existing_intents = list(INTENT_DIR.glob("*.json"))
    referenced_commits = set()
    
    for intent_file in existing_intents:
        try:
            with open(intent_file, 'r', encoding='utf-8') as f:
                intent = json.load(f)
                evidence_notes = intent.get("evidence", {}).get("notes", "")
                # Extract commit SHAs from notes (simple pattern matching)
                matches = re.findall(r'\b[0-9a-f]{40}\b', evidence_notes)
                referenced_commits.update(matches)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            # Skip unreadable or invalid intent files but continue scanning.
            # All file operations must be documented and never silently pass.
            print(f"Warning: Failed to read intent file {intent_file}: {exc}", file=sys.stderr)
    
    # Simplified check: look for significant commits without intents
    # This is a heuristic - in practice, you'd have more sophisticated logic
    for commit_sha in all_commits[:20]:  # Check last 20 commits
        if commit_sha not in referenced_commits:
            commit_info = get_commit_info(commit_sha)
            if commit_info and len(commit_info.get("changed_files", [])) > 0:
                # Check if this commit already added/modified an intent
                intent_modified = any(
                    f.startswith("governance/alteration-program/intent/") and f.endswith(".json")
                    for f in commit_info.get("changed_files", [])
                )
                if not intent_modified:
                    missing.append(commit_sha)
    
    return missing


def main():
    parser = argparse.ArgumentParser(
        description="Generate intent JSON files for commits missing governance intents"
    )
    
    parser.add_argument(
        "--commit",
        help="Generate intent for a specific commit SHA"
    )
    
    parser.add_argument(
        "--output",
        help="Output path for generated intent JSON"
    )
    
    parser.add_argument(
        "--actor-id",
        default="intent-generator",
        help="Actor ID to use in generated intent (default: intent-generator)"
    )
    
    parser.add_argument(
        "--scan",
        action="store_true",
        help="Scan repository for commits missing intents"
    )
    
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print intent JSON without saving"
    )
    
    args = parser.parse_args()
    
    if args.scan:
        print("Scanning repository for commits missing intents...")
        missing_commits = scan_for_missing_intents()
        
        if not missing_commits:
            print("No commits found missing intents.")
            return 0
        
        print(f"\nFound {len(missing_commits)} commits potentially missing intents:\n")
        for sha in missing_commits:
            commit_info = get_commit_info(sha)
            if commit_info:
                print(f"  {commit_info['short_sha']}: {commit_info['subject']}")
        
        print("\nTo generate intent for a commit:")
        print("  python3 tools/intent_generator.py --commit <sha>")
        return 0
    
    if not args.commit:
        parser.print_help()
        return 1
    
    # Generate intent
    print(f"Generating intent for commit {args.commit}...")
    intent = generate_intent_from_commit(args.commit, args.actor_id)
    
    if not intent:
        print("Error: Could not generate intent", file=sys.stderr)
        return 1
    
    if args.dry_run:
        print(json.dumps(intent, indent=2))
        return 0
    
    # Save intent
    output_path = Path(args.output) if args.output else None
    saved_path = save_intent(intent, output_path)
    
    print(f"✓ Intent saved to: {saved_path}")
    print(f"  Intent ID: {intent['intentId']}")
    print(f"  Change Class: {intent['changeClass']}")
    print(f"  Risk Class: {intent['riskClass']}")
    print(f"  Governance Impact: {intent['governanceImpact']}")
    
    # Validate against schema
    print("\nValidating intent against schema...")
    try:
        with open(SCHEMA_PATH, 'r', encoding='utf-8') as f:
            schema = json.load(f)
        
        # Basic validation - check required fields
        required = schema.get("required", [])
        missing_fields = [field for field in required if field not in intent]
        
        if missing_fields:
            print(f"⚠ Warning: Missing required fields: {', '.join(missing_fields)}")
        else:
            print("✓ Intent has all required fields")
        
    except Exception as e:
        print(f"⚠ Could not validate schema: {e}")
    
    print("\nNext steps:")
    print("  1. Review and edit the generated intent file")
    print("  2. Update status to 'in_review' when ready")
    print("  3. Commit the intent file")
    print("  4. Create a PR (must include exactly ONE intent file)")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
