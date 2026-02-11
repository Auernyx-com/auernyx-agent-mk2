# Intent Generator & Fail-Close Review Tooling

## Summary

This PR adds comprehensive tooling to review and process commits that fail CI due to missing governance intent files. The solution includes:

1. **Intent Generator Tool** (`tools/intent_generator.py`)
2. **Auernyx Capability Integration** (`capabilities/intentGenerator.ts`)
3. **GitHub Actions Helper** (`tools/process_failed_runs.py`)
4. **Comprehensive Documentation** (`docs/FAIL_CLOSE_REVIEW_WORKFLOW.md`)

## What Was Added

### Core Tool: intent_generator.py

A Python script that:
- Scans git history to find commits missing intent files
- Generates properly formatted intent JSON from commit metadata
- Automatically classifies changes (root/trunk/branch/leaf)
- Determines governance impact and risk level
- Validates against intent schema
- Supports both scan and generation modes

**Usage:**
```bash
# Scan repository
python3 tools/intent_generator.py --scan

# Generate intent for a commit
python3 tools/intent_generator.py --commit <sha>

# Dry run (print without saving)
python3 tools/intent_generator.py --commit <sha> --dry-run
```

### Capability Integration

Added `intentGenerator` capability to the Auernyx system:
- Registered in `core/policy.ts` as Tier 1 capability
- Added to `config/allowlist.json`
- Integrated in `core/server.ts` capability map
- Routed via `core/router.ts` for "generate intent" commands

This enables governed execution through the Auernyx CLI with approval requirements and audit trails.

### GitHub Actions Helper

`tools/process_failed_runs.py` helps identify and process failed workflow runs:
- Fetches failed `mk2-alteration-gate` runs via GitHub CLI
- Analyzes logs to determine failure reason
- Identifies commits needing intent files
- Can auto-generate intents for failed commits

**Usage:**
```bash
# Check failed runs
python3 tools/process_failed_runs.py --workflow mk2-alteration-gate --limit 10

# Auto-generate intents
python3 tools/process_failed_runs.py --generate
```

### Documentation

- **`docs/FAIL_CLOSE_REVIEW_WORKFLOW.md`**: Complete workflow guide
  - Step-by-step process for reviewing failed commits
  - Batch processing instructions
  - Common issues and solutions
  - Integration examples

- **`tools/README.md`**: Updated with intent generator overview

## How It Works

### Change Classification

The tool automatically classifies changes based on files modified:

| Class | Risk | Examples |
|-------|------|----------|
| Root | High | Governance schema, contracts, core policy |
| Trunk | Medium | Core modules, capabilities, allowlist |
| Branch | Medium | Clients, CI workflows, tooling |
| Leaf | Low | Documentation, tests, minor fixes |

### Governance Impact Detection

Automatically detected if these paths are modified:
- `governance/` directory
- `core/policy.ts`
- `core/router.ts`
- `config/allowlist.json`

When governance impact is detected, the intent requires evidence.

### Scope Inference

The tool infers scope from:
1. Commit message (primary description)
2. File categories (core, capabilities, clients, docs)
3. Change patterns

## Example Output

```json
{
  "intentId": "1770705584416-3702791a",
  "title": "Add intent generator tool and capability for fail-close review",
  "system": "auernyx-agent-mk2",
  "changeClass": "trunk",
  "riskClass": "medium",
  "governanceImpact": true,
  "status": "in_review",
  ...
}
```

## Files Changed

### New Files
- `capabilities/intentGenerator.ts` - Capability wrapper
- `tools/intent_generator.py` - Main Python tool
- `tools/process_failed_runs.py` - GitHub Actions helper
- `docs/FAIL_CLOSE_REVIEW_WORKFLOW.md` - Workflow documentation
- `governance/alteration-program/intent/1770705584416-3702791a.json` - Intent for this PR

### Modified Files
- `config/allowlist.json` - Added intentGenerator
- `core/policy.ts` - Added intentGenerator to CapabilityName and metadata
- `core/router.ts` - Added routing for "generate intent" commands
- `core/server.ts` - Registered intentGenerator capability
- `tools/README.md` - Added intent generator overview

## Testing & Verification

✅ All tests pass:
```bash
npm run verify
# - TypeScript compilation: PASS
# - Core capabilities: PASS
# - Memory check: PASS
# - Repository scan: PASS
```

✅ CI gate validation:
```bash
python3 tools/ci_gate.py
# Mk2 Alteration Gate: PASS
```

✅ Intent generation tested:
- Scan mode works
- Generation from commit SHA works
- Dry-run mode works
- Schema validation passes
- Classification logic verified

## Usage Examples

### For Developers

```bash
# Find commits needing intents
python3 tools/intent_generator.py --scan

# Generate intent
python3 tools/intent_generator.py --commit abc123

# Review and edit the generated file
vim governance/alteration-program/intent/<intentId>.json

# Update status to in_review
# Commit exactly ONE intent file
git add governance/alteration-program/intent/<intentId>.json
git commit -m "Add intent for commit abc123: description"
```

### For CI/CD Integration

```bash
# Check recent failed runs
python3 tools/process_failed_runs.py --workflow mk2-alteration-gate

# Auto-generate intents for all failed commits
python3 tools/process_failed_runs.py --generate
```

### Through Auernyx CLI

```bash
# Scan for missing intents (read-only)
node dist/clients/cli/auernyx.js \
  "scan for missing intents" \
  --input '{"mode":"scan","limit":50}' \
  --reason "identify commits missing intents" \
  --no-daemon

# Generate intent for a specific commit (requires approval)
AUERNYX_WRITE_ENABLED=1 node dist/clients/cli/auernyx.js \
  "generate intent for commit" \
  --input '{"commitSha":"abc123"}' \
  --reason "prep intent for failed commit abc123" \
  --apply --no-daemon
```

## Benefits

1. **Automation**: Reduces manual effort in creating intent files
2. **Consistency**: Ensures all intents follow the same format
3. **Classification**: Automatically determines change class and risk
4. **Validation**: Built-in schema validation
5. **Documentation**: Comprehensive guides and examples
6. **Integration**: Works standalone or through Auernyx CLI
7. **Auditability**: When used via CLI, creates receipts and ledger entries

## Next Steps for Users

1. **Review the generated intent** in this PR
2. **Test the tool** with historical commits if desired
3. **Use in workflow** when commits fail alteration gate
4. **Provide feedback** on classification accuracy
5. **Extend** the tool if additional patterns are needed

## Security & Governance

- Tool is read-only when scanning
- Writes are governed when used via CLI
- Requires approval through Auernyx system
- All generated intents start in "draft" status
- Human review required before status change
- CI gate enforces all validation rules
- No bypass mechanisms introduced

## Dependencies

- Python 3.10+
- Node.js 20+
- npm 11+
- gh CLI (optional, for GitHub Actions helper)

## Intent for This PR

This PR includes its own intent file:
- **Intent ID**: `1770705584416-3702791a`
- **Change Class**: trunk
- **Risk Class**: medium
- **Governance Impact**: true
- **Status**: in_review
- **Location**: `governance/alteration-program/intent/1770705584416-3702791a.json`

The intent was generated using the tool itself (dogfooding) and manually refined.

## Related Documentation

- [Fail-Close Review Workflow](./docs/FAIL_CLOSE_REVIEW_WORKFLOW.md)
- [Intent Generator Tool](./tools/README.md)
- [Alteration Program Doctrine](./governance/alteration-program/ROOT_DOCTRINE.md)
- [Intent Schema](./governance/alteration-program/schema/intent.schema.json)
