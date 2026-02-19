#!/bin/bash

# Create logs directory if it doesn't exist
mkdir -p logs/audit

# Run python script
python3 tools/ci_gate.py >> logs/audit/weekly-audit_$(date +%F).txt

# Run npm verify
npm run verify >> logs/audit/weekly-audit_$(date +%F).txt

# Check if we need to compile
if [ -f dist/clients/cli/auernyx.js ]; then
    # Run memory check
    node dist/clients/cli/auernyx.js memory --reason "weekly audit" --no-daemon >> logs/audit/weekly-audit_$(date +%F).txt
fi

# Print whether AUERNYX_SECRET is set
if [ -z "$AUERNYX_SECRET" ]; then
    echo "AUERNYX_SECRET is not set" >> logs/audit/weekly-audit_$(date +%F).txt
else
    echo "AUERNYX_SECRET is set" >> logs/audit/weekly-audit_$(date +%F).txt
fi

# Print git log
git log --since="7 days ago" --name-status >> logs/audit/weekly-audit_$(date +%F).txt

# Check for errors in logs and exit appropriately
if grep -q "ERROR" logs/audit/weekly-audit_$(date +%F).txt; then
    exit 1
fi
exit 0
