# Tools

## Intent Generator

The **Intent Generator** tool helps generate governance intent JSON files for commits that failed the alteration gate due to missing intent preparation.

### Quick Usage

```bash
# Scan for missing intents
python3 tools/intent_generator.py --scan

# Generate intent for a commit
python3 tools/intent_generator.py --commit <sha>

# Dry run (print without saving)
python3 tools/intent_generator.py --commit <sha> --dry-run
```

See dedicated documentation for more details (workflow, classification, integration).

## Icon pipeline

- Primary command: `npm run assets:icon`
  - Reads `tools/launcher.config.json` (`iconSourcePng`, `iconPath`).
  - Generates a multi-size ICO on Windows.

### Debugging

- Resize-only (keeps temp outputs): `npm run assets:resize`
  - Prints the temp directory containing the resized PNGs.

- Keep temp directory during `assets:icon`:
  - `set AUERNYX_ICON_KEEP_TEMP=1` (cmd.exe)
  - or run: `node tools/make-ico.js --keep-temp`

### Common failure modes

- If you see `System.Drawing is unavailable...`:
  - The resizer requires Windows PowerShell + System.Drawing.
  - Run via `powershell.exe` (Windows PowerShell 5.1). `pwsh` may not work depending on machine/runtime.

- If paths contain spaces:
  - Prefer using `tools/launcher.config.json` to centrally define the PNG path.
  - The current toolchain supports spaces, but “boring” paths tend to be more portable.
