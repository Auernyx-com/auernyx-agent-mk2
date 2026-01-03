# Baseline Records

This file captures SHA-256 hashes for baseline runs so the baseline state is recorded in git even though runtime artifacts under `.auernyx/` and `artifacts/` are gitignored.

## 2026-01-03 — Post-commit baseline POST → baseline PRE

Context:
- Code state: local `main` (ahead of `origin/main`)
- Sequence requested: baseline POST (post-commit) then baseline PRE again

Artifacts:
- Baseline POST receipt
  - runId: `1767410470323-235334a9a691`
  - file: `.auernyx/receipts/1767410470323-235334a9a691/final.json`
  - sha256: `7C1469073384DBE482C02227AF99F1D49893A89BC7098FF2C8A82B00975D6D98`

- Baseline PRE receipt
  - runId: `1767410473562-8cebf7d38a08`
  - file: `.auernyx/receipts/1767410473562-8cebf7d38a08/final.json`
  - sha256: `DD12CC726DA03B07E2CACB5EDE1BAF1E554DAE3A26B20C5A6C85E79C0EE18F0A`

- Kintsugi policy snapshot created during baseline PRE
  - file: `.auernyx/kintsugi/policy/history/20260103T032113_574Z_d80823b7-f003-4a19-8f39-a96fe66fc41e.policy.json`
  - sha256: `C3950CCBC2A8560869D3A198B8EBBDCC6C77B2A21158311DA64D9AE59E8A5850`
