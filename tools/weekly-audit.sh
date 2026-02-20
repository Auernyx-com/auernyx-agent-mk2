#!/bin/bash
set -e

# Establish repository root (one level up from this script) and change to it
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || {
    echo "Error: Failed to cd to repository root: $REPO_ROOT" >&2
    exit 1
}

# Ensure log directory exists
mkdir -p logs/audit

CURRENT_DATE=$(date +%F)
CURRENT_SHA=$(git rev-parse --short HEAD)
LOG_FILE="logs/audit/weekly-audit_${CURRENT_DATE}_${CURRENT_SHA}.txt"

# Print START header
echo "START of Weekly Audit" | tee -a "$LOG_FILE"

# Fail-closed if auernyx.js is missing
if [ ! -f dist/clients/cli/auernyx.js ]; then
    echo "Error: dist/clients/cli/auernyx.js is missing. Failing..." | tee -a "$LOG_FILE"
    exit 1
fi

# Existing steps
python3 tools/ci_gate.py 2>&1 | tee -a "$LOG_FILE"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
    echo "Error: python3 tools/ci_gate.py failed with exit code $status" | tee -a "$LOG_FILE"
    exit "$status"
fi

npm run verify 2>&1 | tee -a "$LOG_FILE"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
    echo "Error: npm run verify failed with exit code $status" | tee -a "$LOG_FILE"
    exit "$status"
fi

node dist/clients/cli/auernyx.js memory --reason "weekly audit" --no-daemon 2>&1 | tee -a "$LOG_FILE"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
    echo "Error: auernyx memory check failed with exit code $status" | tee -a "$LOG_FILE"
    exit "$status"
fi

git log --since "7 days ago" --name-status 2>&1 | tee -a "$LOG_FILE"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
    echo "Error: git log failed with exit code $status" | tee -a "$LOG_FILE"
    exit "$status"
fi

# Print PASS footer
echo "PASS" | tee -a "$LOG_FILE"
