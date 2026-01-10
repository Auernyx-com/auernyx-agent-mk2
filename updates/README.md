# Updates Inbox Contract (Mk2 / Auernyx)

## Inbox location (relative to repo root)
Inbox root:
- `updates/incoming/`

Payload folder:
- `updates/incoming/<payloadId>/`

## Required payload files
Inside `updates/incoming/<payloadId>/`:

- `manifest.json`
- `manifest.sha256`
- `files/<relPath from manifest>`

## Apply destinations (relative to repo root)
Each manifest entry `relPath` is written to:
- `<repoRoot>/<relPath>`

Example:
- `tools/apply_updates.ps1` writes to `<repoRoot>/tools/apply_updates.ps1`

## Apply trace log
Append-only log:
- `governance/alteration-program/logs/update_apply.ndjson`

## Quarantine destination (after apply)
After successful apply, payload folder is moved to:
- `C:\_QUARANTINE_\<payloadId>-updates-<yyyyMMdd-HHmmss>\`

## Fail-closed rules
- Payloads MUST be extracted at repo root. Nested paths like `updates/updates/...` are illegal.
- Only one payload may exist in `updates/incoming/` unless applier is invoked with an explicit payloadId.
- Applier refuses to apply if:
  - manifest missing
  - manifest.sha256 mismatch
  - any file missing/mismatched hash/bytes
  - relPath is unsafe (absolute path, traversal, .git)
- After apply, `updates/incoming/` MUST be empty of payload directories.

---

## For humans: how a payload is delivered (plain-English)

### What you receive
You will usually receive a folder or a `.zip` file that *contains* `updates/incoming/<payloadId>/...`.

This repo does **not** require payloads to be compressed; the only requirement is the **final extracted folder layout**.

### Where to put it
Unzip (or copy) the payload **into the repo root folder**:

- ✅ Correct: extract into `C:\Projects\auernyx-agent-mk2\`
- ❌ Incorrect: extract into `C:\Projects\auernyx-agent-mk2\updates\`

### What “correct” looks like (after unzip/copy)
After delivery, you should have:

`<repoRoot>/updates/incoming/<payloadId>/manifest.json`  
`<repoRoot>/updates/incoming/<payloadId>/manifest.sha256`  
`<repoRoot>/updates/incoming/<payloadId>/files/...`

Example tree:

```
auernyx-agent-mk2\
  updates\
    incoming\
      20260110-002027-72f242aa\
        manifest.json
        manifest.sha256
        files\
          tools\apply_updates.ps1
          updates\README.md
```

### Quick check: is the payload in the right place?
From repo root:

```powershell
Get-ChildItem .\updates\incoming -Force
```

Expected:
- Either only `.gitkeep` (no payload waiting), or
- Exactly **one** payload folder (like `20260110-...`) plus `.gitkeep`.

### How it is “referenced” for apply
The applier looks in `updates/incoming/` and selects:
- the only payload folder present, or
- a specific one if you pass `-PayloadId <payloadId>`.

### Apply (fail-closed)
From repo root:

```powershell
powershell -ExecutionPolicy Bypass -File tools\apply_updates.ps1 -ActorId <your-id>
```

Or the preferred “one command” flow (apply → gate → bastion secondary record):

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File tools\mk2_momentum.ps1 -ActorId <your-id>
```

### What happens after apply
- The payload folder is moved to `C:\_QUARANTINE_\...`
- A trace line is appended to:
  `governance/alteration-program/logs/update_apply.ndjson`

