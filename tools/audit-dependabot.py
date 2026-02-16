#!/usr/bin/env python3
"""
Dependabot Audit Tool

This tool audits the repository for merged Dependabot PRs that bypassed governance.
It identifies all dependency updates that were merged without intent files and provides
a forensic report for remediation.

Usage:
  python3 tools/audit-dependabot.py
  python3 tools/audit-dependabot.py --format json
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]


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


def get_all_commits() -> List[str]:
    """Get all commit SHAs in the repository."""
    cmd = ["git", "-C", str(REPO_ROOT), "rev-list", "--all"]
    output, rc = run_cmd(cmd, check=False)
    if rc != 0:
        return []
    return [line.strip() for line in output.split('\n') if line.strip()]


def get_commit_info(commit_sha: str) -> Optional[Dict]:
    """Extract metadata from a git commit."""
    # Get commit details
    cmd = [
        "git", "-C", str(REPO_ROOT), "show",
        "--no-patch",
        "--format=%H%n%an%n%ae%n%ai%n%s%n%b",
        commit_sha
    ]
    output, rc = run_cmd(cmd, check=False)
    
    if rc != 0:
        return None
    
    lines = output.split('\n')
    if len(lines) < 5:
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
    
    # Get merge info (is this a merge commit?)
    cmd = ["git", "-C", str(REPO_ROOT), "rev-list", "--parents", "-n", "1", commit_sha]
    parents_output, _ = run_cmd(cmd, check=False)
    parents = parents_output.split()
    is_merge = len(parents) > 2  # First element is the commit itself
    
    return {
        "sha": full_sha,
        "short_sha": full_sha[:8],
        "author_name": author_name,
        "author_email": author_email,
        "commit_date": commit_date,
        "subject": subject,
        "body": body,
        "changed_files": changed_files,
        "is_merge": is_merge
    }


def is_dependabot_commit(commit_info: Dict) -> bool:
    """Determine if a commit is from Dependabot."""
    # Check author name/email
    author_name = commit_info.get("author_name", "").lower()
    author_email = commit_info.get("author_email", "").lower()
    
    # Dependabot patterns
    if "dependabot" in author_name or "dependabot" in author_email:
        return True
    
    # Check commit message patterns
    subject = commit_info.get("subject", "").lower()
    body = commit_info.get("body", "").lower()
    
    # Common Dependabot commit message patterns
    dependabot_patterns = [
        r"bump .* from .* to .*",
        r"update .* requirement from .* to .*",
        r"chore\(deps.*\):",
        r"build\(deps.*\):",
    ]
    
    full_message = subject + " " + body
    for pattern in dependabot_patterns:
        if re.search(pattern, full_message):
            return True
    
    return False


def has_intent_file(commit_info: Dict) -> bool:
    """Check if a commit modified an intent file."""
    for f in commit_info.get("changed_files", []):
        if f.startswith("governance/alteration-program/intent/") and f.endswith(".json"):
            return True
    return False


def extract_dependency_info(commit_info: Dict) -> Dict[str, str]:
    """Extract dependency name and version changes from commit."""
    subject = commit_info.get("subject", "")
    
    # Try to parse "bump X from Y to Z" pattern
    # Use non-space character class for package and version to handle PR numbers correctly
    match = re.search(r"bump\s+(.+?)\s+from\s+(\S+)\s+to\s+(\S+)(?:\s+\(#(\d+)\))?", subject, re.IGNORECASE)
    if match:
        return {
            "package": match.group(1).strip(),
            "from_version": match.group(2).strip(),
            "to_version": match.group(3).strip(),
            "pr_number": match.group(4) if match.group(4) else None
        }
    
    # Try to parse "update X requirement" pattern
    # Use non-space character class for versions
    match = re.search(r"update\s+(.+?)\s+requirement\s+from\s+(\S+)\s+to\s+(\S+)(?:\s+\(#(\d+)\))?", subject, re.IGNORECASE)
    if match:
        return {
            "package": match.group(1).strip(),
            "from_version": match.group(2).strip(),
            "to_version": match.group(3).strip(),
            "pr_number": match.group(4) if match.group(4) else None
        }
    
    return {"package": "unknown", "from_version": "unknown", "to_version": "unknown", "pr_number": None}


def classify_change_risk(dep_info: Dict) -> str:
    """Classify risk level of dependency change."""
    from_ver = dep_info.get("from_version", "")
    to_ver = dep_info.get("to_version", "")
    
    # Extract major version numbers
    from_major = re.match(r"(\d+)", from_ver)
    to_major = re.match(r"(\d+)", to_ver)
    
    if from_major and to_major:
        from_major_num = int(from_major.group(1))
        to_major_num = int(to_major.group(1))
        
        if to_major_num > from_major_num:
            return "high"  # Major version bump
    
    return "low"  # Minor or patch version bump


def audit_repository() -> Dict:
    """Audit repository for ungoverned Dependabot commits."""
    print("Scanning repository for Dependabot commits...", file=sys.stderr)
    
    all_commits = get_all_commits()
    dependabot_commits = []
    ungoverned_commits = []
    
    for commit_sha in all_commits:
        commit_info = get_commit_info(commit_sha)
        if not commit_info:
            continue
        
        if is_dependabot_commit(commit_info):
            dependabot_commits.append(commit_info)
            
            # Check if it has an intent file
            if not has_intent_file(commit_info):
                dep_info = extract_dependency_info(commit_info)
                risk = classify_change_risk(dep_info)
                
                ungoverned_commits.append({
                    "commit": commit_info,
                    "dependency": dep_info,
                    "risk": risk
                })
    
    return {
        "scan_date": datetime.now(timezone.utc).isoformat(),
        "total_commits_scanned": len(all_commits),
        "dependabot_commits_found": len(dependabot_commits),
        "ungoverned_commits": len(ungoverned_commits),
        "commits": ungoverned_commits
    }


def print_text_report(audit_result: Dict):
    """Print human-readable audit report."""
    print("\n" + "=" * 80)
    print("DEPENDABOT GOVERNANCE BREACH AUDIT REPORT")
    print("=" * 80)
    print(f"\nScan Date: {audit_result['scan_date']}")
    print(f"Total Commits Scanned: {audit_result['total_commits_scanned']}")
    print(f"Dependabot Commits Found: {audit_result['dependabot_commits_found']}")
    print(f"UNGOVERNED COMMITS: {audit_result['ungoverned_commits']}")
    
    if audit_result['ungoverned_commits'] == 0:
        print("\n✓ No governance violations found.")
        return
    
    print("\n" + "-" * 80)
    print("UNGOVERNED DEPENDABOT COMMITS:")
    print("-" * 80)
    
    for idx, entry in enumerate(audit_result['commits'], 1):
        commit = entry['commit']
        dep = entry['dependency']
        risk = entry['risk']
        
        print(f"\n{idx}. Commit: {commit['short_sha']}")
        print(f"   Author: {commit['author_name']} <{commit['author_email']}>")
        print(f"   Date: {commit['commit_date']}")
        print(f"   Subject: {commit['subject']}")
        print(f"   Package: {dep['package']}")
        print(f"   Version Change: {dep['from_version']} → {dep['to_version']}")
        print(f"   PR: #{dep['pr_number']}" if dep['pr_number'] else "   PR: unknown")
        print(f"   Risk Level: {risk.upper()}")
        print(f"   Files Changed: {len(commit['changed_files'])}")
        
        if commit['changed_files']:
            print(f"   Key Files:")
            for f in commit['changed_files'][:5]:
                print(f"     - {f}")
    
    print("\n" + "=" * 80)
    print("REMEDIATION REQUIRED:")
    print("=" * 80)
    print(f"\n{audit_result['ungoverned_commits']} commit(s) need retroactive intent files.")
    print("\nNext steps:")
    print("  1. Run: python3 tools/restore-dependabot-governance.py")
    print("  2. Review generated intent files")
    print("  3. Commit intent files to restore governance")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Audit repository for ungoverned Dependabot commits"
    )
    
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text)"
    )
    
    parser.add_argument(
        "--output",
        help="Output file path (default: stdout)"
    )
    
    args = parser.parse_args()
    
    # Run audit
    audit_result = audit_repository()
    
    # Output results
    if args.format == "json":
        output = json.dumps(audit_result, indent=2)
        if args.output:
            with open(args.output, 'w') as f:
                f.write(output)
            print(f"Audit report saved to: {args.output}", file=sys.stderr)
        else:
            print(output)
    else:
        print_text_report(audit_result)
        if args.output:
            print(f"\nNote: Text format output to stdout only. Use --format json for file output.", file=sys.stderr)
    
    # Exit with non-zero if violations found
    return 1 if audit_result['ungoverned_commits'] > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
