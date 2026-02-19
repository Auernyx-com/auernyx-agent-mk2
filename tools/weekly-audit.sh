#!/bin/bash
set -euo pipefail

# Ensure that dist/clients/cli/auernyx.js exists
if [ ! -f "dist/clients/cli/auernyx.js" ]; then
  echo "dist/clients/cli/auernyx.js is missing!"
  exit 1
fi

# Run the CI gate script
python3 tools/ci_gate.py

# Run npm verify
npm run verify

# Run the memory check
node dist/clients/cli/auernyx.js memory --reason "weekly audit" --no-daemon

# Print whether AUERNYX_SECRET is set
if [ -z "${AUERNYX_SECRET+x}" ]; then
  echo "AUERNYX_SECRET is not set"
else
  echo "AUERNYX_SECRET is set"
fi

# Log the last 7 days of git changes
git log --since "7 days ago" --name-status

# Write PASS/FAIL summary
