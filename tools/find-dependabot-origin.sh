#!/bin/bash
# Find Dependabot Origin and Bypass History
#
# This script traces:
# 1. Who added .github/dependabot.yml (initial commit + author)
# 2. Who added the bypass to mk2-alteration-gate.yml (commit + author)
# 3. Who merged the Dependabot PRs (check merge commits)

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "======================================================================"
echo "DEPENDABOT ORIGIN AND BYPASS INVESTIGATION"
echo "======================================================================"
echo ""

# 1. Find who added .github/dependabot.yml
echo "1. Dependabot Configuration (.github/dependabot.yml)"
echo "----------------------------------------------------------------------"
if [ -f .github/dependabot.yml ]; then
    echo "File exists: .github/dependabot.yml"
    
    # Find first commit that added this file
    FIRST_COMMIT=$(git log --diff-filter=A --format="%H" -- .github/dependabot.yml | tail -1)
    
    if [ -n "$FIRST_COMMIT" ]; then
        echo ""
        echo "Initial commit that added Dependabot config:"
        git show --no-patch --format="  Commit: %H%n  Author: %an <%ae>%n  Date: %ai%n  Subject: %s" "$FIRST_COMMIT"
        
        echo ""
        echo "File contents from that commit:"
        git show "$FIRST_COMMIT:.github/dependabot.yml" | sed 's/^/  /'
    else
        echo "  ⚠ Could not find commit that added this file (shallow clone?)"
    fi
else
    echo "  File does not exist"
fi

echo ""
echo ""

# 2. Find who added the bypass to mk2-alteration-gate.yml
echo "2. Alteration Gate Bypass (mk2-alteration-gate.yml)"
echo "----------------------------------------------------------------------"
if [ -f .github/workflows/mk2-alteration-gate.yml ]; then
    echo "File exists: .github/workflows/mk2-alteration-gate.yml"
    
    # Check if bypass currently exists
    if grep -q "github.actor != 'dependabot\[bot\]'" .github/workflows/mk2-alteration-gate.yml; then
        echo "  ⚠ BYPASS CURRENTLY ACTIVE"
        echo ""
        echo "Current bypass line:"
        grep -n "github.actor != 'dependabot\[bot\]'" .github/workflows/mk2-alteration-gate.yml | sed 's/^/  /'
        echo ""
        
        # Find when this line was added
        echo "Git blame for the bypass line:"
        git blame -L "/github.actor.*dependabot/,+1" .github/workflows/mk2-alteration-gate.yml 2>/dev/null | sed 's/^/  /' || echo "  (Could not determine)"
        
        echo ""
        
        # Search for commits that added this pattern
        echo "Commits that introduced the bypass:"
        git log --all --format="%H %an <%ae> %ai - %s" -S "github.actor != 'dependabot[bot]'" -- .github/workflows/mk2-alteration-gate.yml | sed 's/^/  /' || echo "  (No commits found - may be in initial commit)"
    else
        echo "  ✓ No bypass found (may have been removed)"
    fi
    
    # Show first commit that added this file
    FIRST_COMMIT=$(git log --diff-filter=A --format="%H" -- .github/workflows/mk2-alteration-gate.yml | tail -1)
    if [ -n "$FIRST_COMMIT" ]; then
        echo ""
        echo "Initial commit that created the workflow:"
        git show --no-patch --format="  Commit: %H%n  Author: %an <%ae>%n  Date: %ai%n  Subject: %s" "$FIRST_COMMIT"
    fi
else
    echo "  File does not exist"
fi

echo ""
echo ""

# 3. Find who merged Dependabot PRs
echo "3. Merged Dependabot Pull Requests"
echo "----------------------------------------------------------------------"
echo "Searching for Dependabot merge commits..."
echo ""

# Find commits with Dependabot patterns
DEPENDABOT_COMMITS=$(git log --all --format="%H|%an|%ae|%ai|%s" --grep="bump.*from.*to.*" -i)

if [ -n "$DEPENDABOT_COMMITS" ]; then
    echo "Found Dependabot-related commits:"
    echo ""
    
    echo "$DEPENDABOT_COMMITS" | while IFS='|' read -r SHA AUTHOR EMAIL DATE SUBJECT; do
        echo "  Commit: ${SHA:0:8}"
        echo "  Author: $AUTHOR <$EMAIL>"
        echo "  Date: $DATE"
        echo "  Subject: $SUBJECT"
        
        # Check if this commit modified an intent file
        INTENT_FILES=$(git diff-tree --no-commit-id --name-only -r "$SHA" | grep "governance/alteration-program/intent/.*\.json" || true)
        if [ -n "$INTENT_FILES" ]; then
            echo "  Intent file: ✓ YES"
        else
            echo "  Intent file: ✗ NO (GOVERNANCE BREACH)"
        fi
        
        # Check if it's a merge commit
        PARENT_COUNT=$(git rev-list --parents -n 1 "$SHA" | wc -w)
        if [ "$PARENT_COUNT" -gt 2 ]; then
            echo "  Type: Merge commit"
        else
            echo "  Type: Direct commit"
        fi
        
        echo ""
    done
else
    echo "  No Dependabot commits found in visible history"
    echo "  (This may be due to a shallow clone)"
fi

echo ""
echo "======================================================================"
echo "INVESTIGATION COMPLETE"
echo "======================================================================"
echo ""
echo "Summary:"
echo "  - Check if Dependabot was enabled in repository settings"
echo "  - Check if bypass existed in initial commit of alteration gate"
echo "  - Check GitHub PR history for actual merge events"
echo ""
echo "To see full GitHub PR history including who approved/merged:"
echo "  1. Go to: https://github.com/Auernyx-com/auernyx-agent-mk2/pulls?q=is:pr+author:dependabot"
echo "  2. Check each closed PR for merge details"
echo ""
