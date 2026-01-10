# Registry, Auto-Discovery, and Pruning

Auto-discovery scans origin branches for `.mk2/handshake.json` and generates `branches/compat-matrix.generated.json`.

Canary pipeline:
- merges staging commit into each connected branch in isolation
- runs required checks per handshake.requires
- only branches that pass can receive propagation PRs

Pruning:
- requires branch lifecycle RETIRED
- requires prune approval receipt (receipt gate)
- then deletes remote branch and records as PRUNED (via registry update)
