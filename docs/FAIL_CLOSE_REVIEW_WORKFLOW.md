# Fail-Close Review Workflow

## Overview

This document describes the workflow for reviewing commits that failed CI due to missing intent files and preparing governance intents for them.

## Problem Statement

When a commit is made without a corresponding intent file in `governance/alteration-program/intent/`, the `mk2-alteration-gate` CI workflow will fail with an error like:

```
Fail-closed: must change/add exactly ONE intent under governance/alteration-program/intent (from commit-diff:origin/main...HEAD). Found: []
```

This ensures that no code changes are merged without proper governance documentation and approval.

## Solution: Intent Generator Tool

The Intent Generator tool (`tools/intent_generator.py`) automates the process of creating properly formatted intent files for commits that failed the alteration gate.

## Workflow

### Step 1: Identify Failed Commits

There are several ways to identify commits that need intents:

#### A. From GitHub Actions UI
1. Go to the "Actions" tab in the repository
2. Look for failed `mk2-alteration-gate` workflow runs
3. Note the commit SHA and branch

#### B. Using GitHub CLI (if available)
```bash
gh run list --workflow=mk2-alteration-gate --status=failure --limit=10
```

#### C. Scan Repository Locally
```bash
python3 tools/intent_generator.py --scan
```

### Step 2: Generate Intent for Failed Commit

Once you have the commit SHA, generate an intent:

```bash
# Replace <commit-sha> with the actual SHA
python3 tools/intent_generator.py --commit <commit-sha>
```

This will:
1. Extract commit metadata (author, message, files changed)
2. Classify the change (root/trunk/branch/leaf)
3. Determine governance impact
4. Generate a properly formatted intent JSON
5. Save it to `governance/alteration-program/intent/<intentId>.json`

#### Example Output

```
✓ Intent saved to: governance/alteration-program/intent/1770705482578-320bc47b.json
  Intent ID: 1770705482578-320bc47b
  Change Class: trunk
  Risk Class: medium
  Governance Impact: true

Validating intent against schema...
✓ Intent has all required fields

Next steps:
  1. Review and edit the generated intent file
  2. Update status to 'in_review' when ready
  3. Commit the intent file
  4. Create a PR (must include exactly ONE intent file)
```

### Step 3: Review and Edit Generated Intent

Open the generated intent file and review:

1. **Title**: Does it accurately describe the change?
2. **Scope**: Are the in-scope and out-of-scope items correct?
3. **Change Class**: Is the classification correct (leaf/branch/trunk/root)?
4. **Risk Class**: Is the risk level appropriate (low/medium/high)?
5. **Governance Impact**: Does this change affect governance?
6. **Verification Plan**: Does the plan make sense?
7. **Evidence**: Are evidence requirements appropriate?

Make any necessary adjustments to improve accuracy.

### Step 4: Update Intent Status

When ready for review, update the `status` field:

```json
{
  "status": "in_review"
}
```

Status values:
- `draft`: Initial state, not ready for review
- `in_review`: Ready for reviewer approval
- `approved`: Reviewer has approved the intent
- `closed`: Intent is complete and archived
- `deferred`: Postponed for later

### Step 5: Commit the Intent

```bash
git add governance/alteration-program/intent/<intentId>.json
git commit -m "Add intent for commit <short-sha>: <description>"
```

**Important**: Only commit ONE intent file at a time. The alteration gate enforces this rule.

### Step 6: Create Pull Request

```bash
git push origin <your-branch>
gh pr create --title "Intent: <description>" --body "Adds governance intent for commit <sha>"
```

The PR will trigger the `mk2-alteration-gate` workflow, which will validate:
- Exactly one intent file is changed
- Intent ID format is correct (13digits-8hex)
- Filename matches intentId field
- All required fields are present
- Schema validation passes

### Step 7: Handle Closed Intents

If you need to modify an intent that has `status: "closed"`, you must add an amendment:

```json
{
  "status": "closed",
  "amendments": [
    {
      "amendedAt": "2026-02-10T10:00:00Z",
      "actorId": "your-username",
      "reason": "Correcting risk classification after review",
      "fieldsChanged": ["riskClass"]
    }
  ]
}
```

The CI gate will verify that amendments are properly added when modifying closed intents.

## Batch Processing Multiple Failed Commits

If you have multiple commits that need intents:

1. **List all failed commits**:
   ```bash
   python3 tools/intent_generator.py --scan
   ```

2. **Generate intents one by one**:
   ```bash
   for sha in abc123 def456 ghi789; do
     python3 tools/intent_generator.py --commit $sha
     echo "Generated intent for $sha"
   done
   ```

3. **Review all generated intents**:
   ```bash
   ls -lt governance/alteration-program/intent/*.json | head -5
   ```

4. **Process each intent separately**:
   - Review and edit each intent
   - Create one PR per intent
   - Or create separate branches for each intent

## Common Issues and Solutions

### Issue: "Could not find commit"

**Cause**: The commit SHA doesn't exist in the local repository.

**Solution**: Fetch all branches and tags:
```bash
git fetch --all --tags
```

### Issue: "Filename must match intentId"

**Cause**: The filename doesn't match the intentId field.

**Solution**: The tool generates the correct filename automatically. If you manually renamed the file, make sure it matches the intentId exactly.

### Issue: "Missing required field: X"

**Cause**: Generated intent is missing a required field.

**Solution**: This shouldn't happen with the tool. If it does, manually add the missing field or report a bug.

### Issue: "Multiple intent files changed"

**Cause**: More than one intent file was modified in the same commit.

**Solution**: Only commit one intent file at a time. If you have multiple intents:
1. Stage one intent at a time
2. Commit separately
3. Create separate PRs or push commits sequentially

## Integration with Auernyx CLI

The intent generator is also available as a governed capability:

```bash
# Through the CLI (requires write-gate enabled)
# NOTE: The commit SHA must be passed via --input; it is not parsed from the intent text.
AUERNYX_WRITE_ENABLED=1 node dist/clients/cli/auernyx.js \
  "generate intent" \
  --input '{"commitSha": "abc123"}' \
  --reason "prep intent for failed commit" \
  --apply --no-daemon

# For scanning mode
AUERNYX_WRITE_ENABLED=1 node dist/clients/cli/auernyx.js \
  "generate intent" \
  --input '{"scan": true}' \
  --reason "scan for missing intents" \
  --apply --no-daemon
```

This routes through the Auernyx governance system and:
- Requires approval
- Generates receipts
- Records in ledger
- Follows plan-based execution

## Monitoring and Metrics

Track intent generation metrics:

```bash
# Count intents by status
jq -r '.status' governance/alteration-program/intent/*.json | sort | uniq -c

# Count intents by change class
jq -r '.changeClass' governance/alteration-program/intent/*.json | sort | uniq -c

# Find all draft intents
jq -r 'select(.status == "draft") | .intentId' governance/alteration-program/intent/*.json
```

## See Also

- [Intent Generator Tool README](../tools/README.md)
- [Intent Schema](../governance/alteration-program/schema/intent.schema.json)
- [Alteration Program Doctrine](../governance/alteration-program/ROOT_DOCTRINE.md)
- [CI Gate Script](../tools/ci_gate.py)
