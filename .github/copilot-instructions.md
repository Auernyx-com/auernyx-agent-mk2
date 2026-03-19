# Copilot Instructions: Auernyx Agent Mk2

## Project Overview
**Auernyx Agent Mk2** is a governed AI orchestrator with strict policy enforcement and tamper-evident audit trails. It is a TypeScript/Node.js daemon-first system that separates reasoning (Auernyx), execution (controlled capabilities), and audit (Kintsugi ledger). This is NOT a VS Code extension—it's editor-agnostic with daemon-based operation.

**Key Characteristics:**
- **Type**: Governed control plane with MCP execution architecture
- **Size**: ~270 source files, ~4,658 lines in core modules
- **Languages**: TypeScript (primary), Python (CI scripts), PowerShell (Windows launchers)
- **Runtime**: Node.js v20+ (tested with v24.13.0), npm 11+, Python 3.10+
- **Architecture**: Policy-first, plan-based execution with receipts, NO direct capability execution

## Critical Build & Validation Workflow

### Prerequisites (ALWAYS verify first)
1. Node.js v20+ and npm v11+ installed
2. Python 3.10+ available for CI gate scripts
3. Clean working tree for governed operations (**NEVER** use `--allow-dirty` in production; see security warning below)

### Build Commands (run in order)
```bash
# 1. Install dependencies (use npm ci in CI, npm install locally)
npm ci  # or npm install for local dev

# 2. Compile TypeScript (REQUIRED before any CLI/daemon usage)
npm run compile

# 3. Type checking only (no output)
npm run typecheck

# 4. Full verification (typecheck + compile + basic capability tests)
npm run verify
```

**CRITICAL BUILD NOTES:**
- **ALWAYS** run `npm run compile` after pulling changes or modifying TypeScript files
- Build output goes to `dist/` directory (gitignored)
- Compilation typically completes in <5 seconds
- The `verify` script runs memory check and scan capabilities (takes ~10-15 seconds)
- If `verify` fails, check that `.auernyx/` directories exist (created on first run)

### CLI Usage Patterns
```bash
# All CLI commands follow this pattern:
node dist/clients/cli/auernyx.js <intent> [options]

# Common read-only commands (safe, no APPLY needed):
node dist/clients/cli/auernyx.js memory --reason "health check" --no-daemon
node dist/clients/cli/auernyx.js scan . --reason "repo scan" --no-daemon

# Mutating commands (REQUIRE --apply flag):
AUERNYX_WRITE_ENABLED=1 node dist/clients/cli/auernyx.js baseline pre --reason "snapshot" --apply --no-daemon

# Daemon mode (preferred for production):
# Start daemon: node dist/clients/cli/auernyx-daemon.js
# Use without --no-daemon flag to route through daemon
```

**CLI Flags:**
- `--reason <TEXT>`: Required for non-interactive approval (always provide this)
- `--apply`: Required to enable mutating operations
- `--no-daemon`: Force local execution (skip daemon), use for testing
- `--allow-dirty`: **⚠️ SECURITY RISK** - Bypasses working tree cleanliness check. ONLY use in isolated test/sandbox environments with no access to production data. This flag can compromise governance integrity if misused.

### Environment Variables
- `AUERNYX_WRITE_ENABLED`: Controls write operations (env var takes precedence over config)
  - Set to `1` to enable writes (overrides config file)
  - Set to `0` to disable writes (overrides config file)
  - If unset, falls back to `config/auernyx.config.json` `writeEnabled` field (default: false)
- `AUERNYX_SECRET`: Daemon authentication secret (optional, for production)
- `AUERNYX_RECEIPTS_ENABLED`: Enable/disable receipt generation (default: enabled)
- `AUERNYX_PORT`: Daemon port (default: 43117)
- `AUERNYX_HOST`: Daemon host (default: 127.0.0.1)

## Repository Structure & Key Paths

### Core Directories
- **`core/`**: Governance core (router, policy, planner, ledger, receipts) - ~4,658 lines
  - `router.ts`: Intent → capability mapping, enforces plan-based execution
  - `policy.ts`: Allowlist enforcement, approval requirements
  - `planner.ts`: Generates structured step plans
  - `runLifecycle.ts`: Single execution path for all capabilities
  - `ledger.ts`: Append-only hash-chained audit log
  - `receipts.ts`: Receipt generation for every run
  - `server.ts`: HTTP daemon server (port 43117)
  
- **`capabilities/`**: Action modules (scan, baseline, feneris, governance, etc.)
  - All capabilities must be allowlisted in `config/allowlist.json`
  - Mutating capabilities require approval and `AUERNYX_WRITE_ENABLED=1`
  
- **`clients/`**: CLI and VS Code clients (thin wrappers)
  - `cli/auernyx.ts`: CLI entry point
  - `cli/auernyx-daemon.ts`: Daemon server entry point
  - `vscode/extension.ts`: VS Code integration (thin wrapper only)

- **`config/`**: Configuration files
  - `auernyx.config.json`: Daemon config (port, secret, paths)
  - `allowlist.json`: Capability allowlist (enforced by policy layer)
  - `vscode-policy.json`: VS Code-specific policy overrides

- **`governance/`**: Governance artifacts and alteration program
  - `alteration-program/intent/`: Intent JSON files (1 per change)
  - `alteration-program/schema/`: JSON schema for intent validation

- **`.auernyx/`**: Runtime governance artifacts (gitignored, protected path)
  - `kintsugi/`: Kintsugi ledger, policy history, Known Good Snapshots
  - `receipts/`: Run receipts (one directory per runId)

### Configuration Files
- `package.json`: npm scripts, dependencies, binary definitions
- `tsconfig.json`: TypeScript compiler config (ES2020, commonjs, strict mode)
- `.gitignore`: Excludes `node_modules/`, `dist/`, `logs/`, `artifacts/`, `.auernyx/`

## CI/CD & GitHub Workflows

### Alteration Gate (mk2-alteration-gate.yml)
**Triggers**: Every PR (opened, synchronize, reopened, edited)
**Purpose**: Enforce fail-closed governance invariants
**Script**: `tools/ci_gate.py`

**Invariants Enforced:**
1. Exactly ONE authorization record must be changed/added under `governance/alteration-program/authorization/records/`
2. The auth record must be valid JSON with required fields: `authorizedBy`, `authorizedAt`, `reason`
3. `authorizedBy` must be a valid GitHub login present in `governance/alteration-program/authorization/allowlist.json`
4. `authorizedAt` must be a valid ISO date (`YYYY-MM-DD`) and must not be in the future
5. Trace files must be append-only: `governance/alteration-program/logs/*.ndjson`
6. `updates/incoming/` must not contain committed payload files
7. The path `updates/updates/` must not exist (illegal nested path)

**How to Pass the Gate:**
- Add or modify exactly one `.json` auth record under `governance/alteration-program/authorization/records/`
- Include `authorizedBy` (your GitHub login, must be in `allowlist.json`), `authorizedAt` (today's date, `YYYY-MM-DD`), and a non-empty `reason` string
- Validate with: `python3 tools/ci_gate.py` (set `MK2_BASE_REF` for PR context)

### Branch Registry Update (branch-registry-update.yml)
**Triggers**: Hourly cron (17 * * * *), manual dispatch
**Purpose**: Auto-discover connected branches and update compat matrix
**Actions**: Runs `node tools/volatility/generate-matrix.mjs`, opens PR if changes detected

### Platform Canary Gate (platform-canary.yml)
**Triggers**: Push to `staging/platform-canary`, manual dispatch
**Actions**: Runs volatility matrix tests for canary validation

## Testing & Validation

### Unit Tests
Run the unit test suite with:
```bash
npm test
```
This compiles with `tsconfig.test.json` and runs `node --test dist/tests/*.test.js`. Test source files live under `tests/` (e.g., `tests/analyzeDependency.test.ts`).

Additional validation is done through:
1. TypeScript type checking (`npm run typecheck`)
2. Compilation verification (`npm run compile`)
3. Capability smoke tests (`npm run verify`)
4. CI gate enforcement (alteration gate)

### Manual Testing Checklist
```bash
# 1. Clean build
rm -rf dist/ && npm run compile

# 2. Run unit tests
npm test

# 3. Verify core functionality
npm run verify

# 4. Test memory check
node dist/clients/cli/auernyx.js memory --reason "test" --no-daemon

# 5. Test repo scan
node dist/clients/cli/auernyx.js scan . --reason "test" --no-daemon

# 6. Test governance self-test
node dist/clients/cli/auernyx.js governance self-test --reason "test" --no-daemon

# 7. Validate CI gate locally (if modifying governance)
python3 tools/ci_gate.py
```

## Code Change Guidelines

### Governance Law (Non-Negotiable Invariants)
From `docs/mk2-governance-law.md`:
1. **Single execution path**: All capability execution flows through `runLifecycle`
2. **Plan-based execution only**: No capability without plan → step → approval
3. **Approvals are step-scoped**: No magical blanket approvals
4. **Evidence is first-class**: Hash-addressed evidence objects
5. **Receipts are mandatory**: Every run produces audit receipt
6. **UI is not privileged**: `/ui` endpoint has same restrictions as API

### Protected Paths (NEVER write to these directly)
- `.auernyx/kintsugi/` (Kintsugi ledger, policy, Known Good Snapshots)
- `governance/alteration-program/logs/*.ndjson` (append-only trace files)
- `logs/ledger.ndjson` (append-only hash-chained ledger)

### When Adding/Modifying Capabilities
1. Add capability to `capabilities/` directory
2. Register in `config/allowlist.json`
3. Update router logic in `core/router.ts` for intent mapping
4. Document in `docs/mk2-capabilities.md`
5. Test with `--no-daemon` flag first, then daemon mode

### Malicious Code Indicators (security review notes)
During comprehensive code review, NO malicious patterns were found:
- ✅ No hardcoded secrets or API keys
- ✅ No eval() or unsafe dynamic code execution
- ✅ Controlled use of child_process/execFileSync in limited modules (e.g., skjoldrFirewall.ts, core/git.ts, tools/make-ico.js) with validated inputs and explicit arguments
- ✅ Git operations use execFileSync with explicit arguments
- ✅ Environment-based secrets (AUERNYX_SECRET) properly handled
- ✅ All write operations are write-gated: `AUERNYX_WRITE_ENABLED` (env) takes precedence, otherwise `config/auernyx.config.json` must set `writeEnabled: true`

### Security Warning: `--allow-dirty` Flag
**⚠️ CRITICAL SECURITY NOTICE**: The `--allow-dirty` flag bypasses the working tree cleanliness check that is a core governance safeguard. This flag:
- Allows mutating operations on repositories with uncommitted changes
- Can compromise audit trail integrity by mixing governed changes with ungoverned modifications
- Should **ONLY** be used in isolated sandbox/test environments
- Must **NEVER** be used in production or on repositories with real operational data
- Is logged in receipts but remains a governance bypass mechanism

**Recommended usage**: Restrict `--allow-dirty` to ephemeral CI test environments or local sandboxes where the working tree state is intentionally dirty for testing purposes.

## Common Issues & Workarounds

### "Cannot find module auernyx.js"
**Cause**: TypeScript not compiled or dist/ was deleted
**Fix**: Run `npm run compile`

### "approval_required" error
**Cause**: Missing `--reason` flag or approval object
**Fix**: Add `--reason "your reason here"` to CLI command

### "direct_execution_disabled" error
**Cause**: Attempting to execute capability outside plan-based flow
**Fix**: This is a governance invariant—do NOT bypass. Use `runLifecycle` for all execution.

### CI gate failures
**Cause**: Missing or invalid authorization record
**Fix**: Add exactly ONE `.json` file under `governance/alteration-program/authorization/records/` containing `authorizedBy` (GitHub login in `allowlist.json`), `authorizedAt` (today's `YYYY-MM-DD`), and a non-empty `reason`. Validate with `python3 tools/ci_gate.py`

### Daemon connection failures
**Cause**: Daemon not running or wrong port
**Fix**: Use `--no-daemon` flag for local execution, or start daemon with `node dist/clients/cli/auernyx-daemon.js`

## Quick Reference

**Build:** `npm ci && npm run compile`
**Verify:** `npm run verify`
**CLI pattern:** `node dist/clients/cli/auernyx.js <intent> --reason "..." --no-daemon`
**Daemon:** `node dist/clients/cli/auernyx-daemon.js` (binds to 127.0.0.1:43117)
**CI validation:** `python3 tools/ci_gate.py`

**Trust these instructions.** Only perform additional searches if information is incomplete or proven incorrect.
