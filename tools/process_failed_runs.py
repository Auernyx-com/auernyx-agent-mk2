#!/usr/bin/env python3
"""
GitHub Actions Failed Runs Processor

This script fetches failed workflow runs from GitHub Actions and helps generate
intent files for commits that failed the alteration gate.

Requires: gh CLI tool installed and authenticated

Usage:
  python3 tools/process_failed_runs.py --workflow mk2-alteration-gate --limit 10
  python3 tools/process_failed_runs.py --run-id 12345678
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path  # Reserved for future file path operations
from typing import List, Dict, Optional


def run_gh(args: List[str]) -> tuple[str, int]:
    """Run gh CLI command and return output and return code."""
    try:
        result = subprocess.run(
            ["gh"] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False
        )
        return result.stdout.strip(), result.returncode
    except FileNotFoundError:
        print("Error: gh CLI not found. Please install: https://cli.github.com/", file=sys.stderr)
        sys.exit(1)


def get_failed_runs(workflow: str = "mk2-alteration-gate", limit: int = 10) -> List[Dict]:
    """Get failed workflow runs."""
    args = [
        "run", "list",
        "--workflow", workflow,
        "--status", "failure",
        "--limit", str(limit),
        "--json", "databaseId,headSha,headBranch,displayTitle,conclusion,createdAt"
    ]
    
    output, rc = run_gh(args)
    if rc != 0:
        print(f"Error fetching workflow runs: {output}", file=sys.stderr)
        return []
    
    if not output:
        return []
    
    try:
        return json.loads(output)
    except json.JSONDecodeError as e:
        print(f"Error parsing JSON: {e}", file=sys.stderr)
        return []


def get_run_logs(run_id: int) -> Optional[str]:
    """Get logs for a specific run."""
    args = ["run", "view", str(run_id), "--log-failed"]
    output, rc = run_gh(args)
    
    if rc != 0:
        return None
    
    return output


def extract_missing_intent_info(logs: str) -> Optional[Dict]:
    """Extract information about missing intent from logs."""
    # Look for the fail-closed error message
    if "Fail-closed:" in logs and "must change/add exactly ONE intent" in logs:
        return {
            "reason": "missing_intent",
            "message": "No intent file found for changes"
        }
    
    if "intentId must match 13digits-8hex" in logs:
        return {
            "reason": "invalid_intent_id",
            "message": "Intent ID format is incorrect"
        }
    
    if "filename must match intentId" in logs:
        return {
            "reason": "filename_mismatch",
            "message": "Intent filename doesn't match intentId field"
        }
    
    return None


def main():
    parser = argparse.ArgumentParser(
        description="Process failed GitHub Actions runs and identify commits needing intents"
    )
    
    parser.add_argument(
        "--workflow",
        default="mk2-alteration-gate",
        help="Workflow name to check (default: mk2-alteration-gate)"
    )
    
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Number of runs to check (default: 10)"
    )
    
    parser.add_argument(
        "--run-id",
        type=int,
        help="Specific run ID to check"
    )
    
    parser.add_argument(
        "--generate",
        action="store_true",
        help="Automatically generate intents for failed commits"
    )
    
    args = parser.parse_args()
    
    if args.run_id:
        # Process specific run
        print(f"Checking run {args.run_id}...")
        logs = get_run_logs(args.run_id)
        
        if logs:
            info = extract_missing_intent_info(logs)
            if info:
                print(f"  Reason: {info['reason']}")
                print(f"  Message: {info['message']}")
            else:
                print("  No intent-related failure detected")
        else:
            print("  Could not fetch logs")
        
        return 0
    
    # Fetch failed runs
    print(f"Fetching failed runs for workflow '{args.workflow}'...")
    runs = get_failed_runs(args.workflow, args.limit)
    
    if not runs:
        print("No failed runs found.")
        return 0
    
    print(f"\nFound {len(runs)} failed runs:\n")
    
    commits_needing_intents = []
    
    for run in runs:
        run_id = run.get("databaseId")
        sha = run.get("headSha", "")[:8]
        branch = run.get("headBranch", "")
        title = run.get("displayTitle", "")
        created = run.get("createdAt", "")
        
        print(f"Run {run_id} ({created[:10]}):")
        print(f"  Branch: {branch}")
        print(f"  Commit: {sha}")
        print(f"  Title: {title}")
        
        # Check logs to determine failure reason
        logs = get_run_logs(run_id)
        if logs:
            info = extract_missing_intent_info(logs)
            if info:
                print(f"  Reason: {info['reason']}")
                print(f"  Message: {info['message']}")
                
                if info['reason'] == 'missing_intent':
                    commits_needing_intents.append(run.get("headSha"))
            else:
                print("  Reason: other_failure")
        else:
            print("  Could not fetch logs")
        
        print()
    
    if commits_needing_intents:
        print(f"\n{len(commits_needing_intents)} commits need intents:")
        for sha in commits_needing_intents:
            print(f"  {sha[:8]}")
        
        if args.generate:
            print("\nGenerating intents...")
            for sha in commits_needing_intents:
                print(f"\nProcessing {sha[:8]}...")
                try:
                    result = subprocess.run(
                        ["python3", "tools/intent_generator.py", "--commit", sha],
                        capture_output=True,
                        text=True,
                        check=False
                    )
                    
                    if result.returncode == 0:
                        print(f"  ✓ Intent generated")
                    else:
                        print(f"  ✗ Failed: {result.stderr}")
                except Exception as e:
                    print(f"  ✗ Error: {e}")
        else:
            print("\nTo generate intents, run:")
            for sha in commits_needing_intents:
                print(f"  python3 tools/intent_generator.py --commit {sha}")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
