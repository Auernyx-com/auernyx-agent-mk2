# Mk2 Governance Law (Invariants)

This document is the line in the sand for Mk2.

After this point, changes to governance behavior must be intentional and reviewed.

## Invariants

1. **Single execution path**
   - All real capability execution flows through `runLifecycle`.
   - Direct capability execution outside a plan step is forbidden.

2. **Plan-based execution only**
   - No capability is reachable without:
     - a deterministic `plan`,
     - a specific `step`,
     - a step-scoped approval (when the policy/tool requires it).

3. **Approvals are step-scoped**
   - Approvals attach to a specific `stepId`.
   - A single “magical” approval must not implicitly authorize multiple steps.

4. **Evidence is first-class**
   - Evidence objects are hash-addressed.
   - Evidence references may be included on approvals and recorded in receipts.

5. **Receipts are mandatory**
   - Every run produces an audit receipt trail.
   - Success and refusal both generate complete receipts with a final status.

6. **UI is not privileged**
   - `/ui` is a thin client calling the same daemon endpoints.
   - It must never become a bypass path.
