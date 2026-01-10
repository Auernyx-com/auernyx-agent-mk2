# Mk2 Branch Handshake (v1)

A branch is "connected" only if it contains `.mk2/handshake.json` that validates against `.mk2/handshake.schema.json`.

Handshake fields:
- schema: mk2.handshake.v1
- branchRole: CONNECTED
- lifecycle: ACTIVE | BROKEN | QUARANTINED | RETIRED | PRUNED
- requires: install | build | test | baseline

Branches without a handshake are excluded from canary tests and propagation.
