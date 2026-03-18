#!/usr/bin/env python3
import json
import sys
import os
import shutil
import hashlib

# Configuration - Schema specific to your records directory
MASTER_SCHEMA_KEYS = {"governance_record", "authorization_logic", "signature"}
QUARANTINE_DIR = "governance/quarantine"
# Pulls the actor handle from GitHub's internal environment
GITHUB_ACTOR = os.getenv("GITHUB_ACTOR", "UNKNOWN_ACTOR")


def quarantine_file(filepath, reason):
    """Isolates the file and logs the failure with the GitHub Actor."""
    if not os.path.exists(QUARANTINE_DIR):
        os.makedirs(QUARANTINE_DIR)

    file_sha = hashlib.sha256(filepath.encode()).hexdigest()[:10]
    filename = os.path.basename(filepath)
    quarantine_path = os.path.join(QUARANTINE_DIR, f"{file_sha}-{filename}")

    try:
        # Move file out of the production records folder
        shutil.move(filepath, quarantine_path)
    except (FileNotFoundError, PermissionError, OSError) as e:
        print(f"WARNING: could not move {filepath} to quarantine: {e}", file=sys.stderr)
        quarantine_path = filepath  # log in-place if move failed

    audit_note = {
        "actor": GITHUB_ACTOR,
        "event": "GATE_FAILURE",
        "file_sha": file_sha,
        "reason": reason,
        "original_path": filepath,
    }

    try:
        with open(f"{quarantine_path}.audit.json", "w") as f:
            json.dump(audit_note, f, indent=2)
    except OSError as e:
        print(f"WARNING: could not write audit note: {e}", file=sys.stderr)


def validate_topograph(filepath):
    if not os.path.exists(filepath):
        return True
    if not filepath.endswith(".json"):
        quarantine_file(filepath, "FILE_TYPE_NON_JSON")
        return False

    try:
        with open(filepath, "r") as f:
            data = json.load(f)

        # Verify internal keys match the expected topograph
        if not MASTER_SCHEMA_KEYS.issubset(set(data.keys())):
            quarantine_file(filepath, "SCHEMA_KEYS_MISMATCH")
            return False

        return True
    except Exception as e:
        quarantine_file(filepath, f"PARSE_FAILURE: {str(e)}")
        return False


if __name__ == "__main__":
    # Script expects list of changed files as arguments
    files = sys.argv[1:]
    exit_code = 0

    records_prefix = os.path.normpath("governance/alteration-program/authorization/records")

    for f in files:
        # Only scan the specific records directory to avoid traffic jams
        norm = os.path.normpath(f)
        if norm.startswith(records_prefix + os.sep) or norm.startswith(records_prefix + "/"):
            if not validate_topograph(f):
                exit_code = 1

    if exit_code == 0:
        print("Mk2 Alteration Gate: PASS")

    sys.exit(exit_code)
