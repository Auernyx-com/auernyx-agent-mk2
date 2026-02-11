# Agent Independence in Auernyx Mk2

## Overview

Auernyx Mk2 provides **two independent agents** that operate separately and do not require each other to run:

1. **VS Code Extension** — Embedded assistant for VS Code users
2. **Headless Agent** — Standalone daemon with CLI and browser UI

## Agent 1: VS Code Extension

### Location
- `clients/vscode/extension.ts`

### Purpose
Provides guided interaction, analysis, and tooling directly inside VS Code.

### Dependencies
- **Required**: VS Code (obviously)
- **Optional**: Daemon (can delegate to it for shared state, but not required)
- **UI**: VS Code APIs (input boxes, dialogs, output channels, status bar)

### Execution Mode
- **Primary**: Local execution using `runLifecycle()`
- **Optional**: Delegates to daemon via `tryRunViaDaemon()` if available
- **Fallback**: Runs locally if daemon is unavailable or times out

### How to Run
```bash
# Development
npm run compile
# Open in VS Code and press F5

# Or install as extension
code --install-extension path/to/extension.vsix
```

### Commands
- Ask Auernyx
- Scan Repo (Auernyx)
- Prepare Feneris Port
- Ask Auernyx (Apply)
- Prepare Feneris Port (Apply)

## Agent 2: Headless Agent

### Components
1. **Daemon** (`clients/cli/auernyx-daemon.ts`) — HTTP JSON API server
2. **CLI** (`clients/cli/auernyx.ts`) — Command-line client
3. **Browser UI** — Web interface at `/ui` endpoint

### Purpose
Provides agent functionality outside VS Code for:
- CLI automation and scripting
- CI/CD integration
- Browser-based interaction
- Remote/headless server environments

### Dependencies
- **Required**: Node.js runtime
- **Optional**: None (completely independent)
- **UI**: 
  - CLI: readline (terminal prompts)
  - Browser: HTTP endpoints at `http://127.0.0.1:43117/ui`

### Execution Modes

#### Mode A: CLI Direct Execution
```bash
npm run cli -- scan
npm run cli -- memory
npm run cli -- baseline pre --reason "pre-check" --apply
```

CLI tries daemon first, falls back to local execution.

#### Mode B: Daemon + CLI
```bash
# Terminal 1: Start daemon
npm run daemon

# Terminal 2: Use CLI (delegates to daemon)
npm run cli -- scan
```

#### Mode C: Daemon + Browser UI
```bash
# Start daemon
npm run daemon

# Open browser
http://127.0.0.1:43117/ui
```

## Shared Core Architecture

Both agents share the same governance core but with different UI layers:

```
┌─────────────────────────────────────────────┐
│           Shared Core (core/)               │
│  ┌────────────┬──────────┬────────────┐    │
│  │ Router     │ Policy   │ Ledger     │    │
│  │ (intents)  │ (guards) │ (receipts) │    │
│  └────────────┴──────────┴────────────┘    │
│                                             │
│         Capabilities (capabilities/)        │
│  ┌──────┬──────┬──────┬──────┬──────┐     │
│  │ Scan │ Prep │ Base │ Roll │ ... │      │
│  └──────┴──────┴──────┴──────┴──────┘     │
└─────────────────────────────────────────────┘
         │                         │
         │                         │
    ┌────▼────┐             ┌─────▼──────┐
    │VS Code  │             │ Headless   │
    │Extension│             │ Agent      │
    │         │             │            │
    │ - Input │             │ - Daemon   │
    │   boxes │             │ - CLI      │
    │ - Status│             │ - Browser  │
    │ - Output│             │   UI       │
    └─────────┘             └────────────┘
```

## Independence Guarantees

### Runtime Independence
✅ VS Code extension runs without daemon  
✅ Daemon runs without VS Code  
✅ CLI runs without VS Code  
✅ CLI runs without daemon (falls back to local)

### No Hard Dependencies
✅ No imports of VS Code types in `core/` or `capabilities/`  
✅ No imports of VS Code types in `clients/cli/*`  
✅ Headless agent uses `readline` for prompts, not VS Code APIs

### Optional Integration
⚠️ VS Code extension **can** delegate to daemon (optional, not required)  
⚠️ CLI **can** delegate to daemon (optional, falls back to local)

This delegation is for **shared state** benefits (single ledger, shared session), not a hard requirement.

## Build Configuration

### package.json
```json
{
  "main": "./dist/clients/vscode/extension.js",
  "bin": {
    "auernyx": "./dist/clients/cli/auernyx.js",
    "auernyx-daemon": "./dist/clients/cli/auernyx-daemon.js"
  }
}
```

### Single Build, Multiple Targets
```bash
npm run compile
```

Compiles all clients to `dist/`:
- `dist/clients/vscode/extension.js` — VS Code extension
- `dist/clients/cli/auernyx.js` — CLI client
- `dist/clients/cli/auernyx-daemon.js` — Daemon server

## Usage Examples

### Scenario 1: VS Code Only (No Daemon)
```bash
# No daemon running
# Open VS Code, press F5
# Run commands via Command Palette
# Everything works locally
```

### Scenario 2: Headless Only (No VS Code)
```bash
# VS Code not installed or not running
npm run daemon
# Browser: http://127.0.0.1:43117/ui
# Or CLI: npm run cli -- scan
```

### Scenario 3: Both Running (Optional Shared State)
```bash
# Terminal 1: Start daemon for shared state
npm run daemon

# Terminal 2: Use CLI (delegates to daemon)
npm run cli -- scan

# VS Code: Commands delegate to daemon if available
# Benefit: Single ledger, shared session across all clients
```

### Scenario 4: CI/CD (Headless, Non-Interactive)
```bash
# No VS Code, no interactive prompts
AUERNYX_WRITE_ENABLED=1 npm run cli -- baseline pre \
  --reason "CI pre-check" \
  --apply \
  --local
```

## Why Two Agents?

### Different Use Cases

**VS Code Extension**
- Interactive development
- Inline guidance
- Rich UI feedback
- Workspace awareness

**Headless Agent**
- CI/CD pipelines
- Server environments
- Automation scripts
- Remote access
- Environments without VS Code

### Different UX Patterns

**VS Code**
- Modal dialogs for approval
- Output channels for logs
- Status bar for state
- File system via VS Code APIs

**Headless**
- Terminal prompts for approval (CLI)
- Form-based UI (browser)
- stdout/stderr for logs
- Direct file system access

## Developer Notes

### Adding a New Capability
When adding capabilities, ensure they work with both agents:

1. Implement in `capabilities/` (shared)
2. Register in `core/router.ts` (shared)
3. Test via VS Code extension
4. Test via CLI: `npm run cli -- <intent>`

### Preventing Tight Coupling
- ❌ Do not import `vscode` types in `core/` or `capabilities/`
- ❌ Do not import `vscode` types in `clients/cli/`
- ✅ Use abstracted interfaces (e.g., approval functions)
- ✅ Keep UI logic in client-specific files

### Approval Pattern (Agent-Agnostic)
```typescript
// VS Code: Modal dialog
const approval = await getApprovalFromUser(capability);

// CLI: readline prompt
const approval = await promptApproval(capability);

// Both produce same shape:
// { reason: string, identity?: string, confirm?: "APPLY" }
```

## Summary

Auernyx Mk2 is designed as **two independent agents** with a shared governance core:

- ✅ **Independent**: Each agent runs standalone
- ✅ **No Required Dependencies**: Neither requires the other
- ✅ **Optional Integration**: Can delegate to daemon for shared state
- ✅ **Shared Governance**: Same policies, same capabilities
- ✅ **Different UX**: Appropriate UI for each environment

This architecture ensures Mk2 works in any environment: VS Code, CLI, browser, CI/CD, or remote servers.
