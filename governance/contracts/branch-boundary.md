# Branch Boundary Contract

This document defines the strict boundary between TRUNK (this repo) and any BRANCH repos (Skjoldr, AEsir, etc.).

## Rules

- Branches must not assume TRUNK paths.
- Branches must not import TRUNK code directly.
- TRUNK must not vendor/copy branch code.
- All integration occurs via /consumers/branches/*.
- Side effects must be receipted.
