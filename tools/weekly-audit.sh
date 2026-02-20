#!/bin/bash
set -e

# Establish repository root (one level up from this script) and change to it
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || {
    echo "Error: Failed to cd to repository root: $REPO_ROOT" >&2
    exit 1
}
# Log file path with current date and short SHA
CURRENT_DATE=$(date +%F)
CURRENT_SHA=$(git rev-parse --short HEAD)
LOG_FILE="logs/audit/weekly-audit_${CURRENT_DATE}_${CURRENT_SHA}.txt"

# Ensure log directory exists
mkdir -p logs/audit
# Print START header
echo "START of Weekly Audit" | tee -a "$LOG_FILE"

# Fail-closed if auernyx.js is missing
if [ ! -f dist/clients/cli/auernyx.js ]; then
    echo "Error: dist/clients/cli/auernyx.js is missing. Failing..." | tee -a "$LOG_FILE"
    exit 1
fi

# Existing steps
python3 ci_gate.py | tee -a $LOG_FILE
npm run verify | tee -a $LOG_FILE
node dist/clients/cli/auernyx.js memory --reason "weekly audit" --no-daemon | tee -a $LOG_FILE
git log --since "7 days ago" --name-status | tee -a $LOG_FILE

# Print PASS footer
echo "PASS" | tee -a "$LOG_FILE"
