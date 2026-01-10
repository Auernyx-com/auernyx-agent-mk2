// Headless CLI runner for Mk2 governance kernel
// Usage: node dist/run-mk2.js "intent string"

import { legitimacyCheck } from "./core/legitimacyGate.js";
import { createPlan } from "./core/planner.js";
import { loadActivePolicy, snapshotPolicy, evaluatePlan } from "./core/policy.js";
import { runPlan } from "./core/router.js";

const EXIT_CODE_FATAL_ERROR = 99;

// Centralized evidence collection for the current run. This can be
// extended or made configurable without changing the main flow.
function collectEvidence(): Set<string> {
  // For now, simulate WORKSPACE_OPEN for demo purposes.
  return new Set<string>(["WORKSPACE_OPEN"]);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("Usage: node dist/run-mk2.js \"intent string\"");
    process.exit(1);
  }
  const rawInput = args.join(" ");

  // 1. Legitimacy check
  const legit = legitimacyCheck(rawInput);
  if (!legit.ok) {
    console.error("Refused by legitimacy gate:", legit.reason);
    process.exit(2);
  }
  const intent = legit.normalizedIntent;

  // 2. Create plan
  const plan = createPlan({ intent, rawInput });

  // 3. Load policy and snapshot
  const policy = loadActivePolicy();
  const snapshot = snapshotPolicy(policy);

  // 4. Collect evidence
  const evidence = collectEvidence();

  // 5. Evaluate plan
  const verdicts = evaluatePlan(plan, snapshot, evidence);

  // 6. Run plan
  const workspaceRoot = process.cwd();
  const result = await runPlan(workspaceRoot, plan, snapshot, verdicts);

  // 7. Print summary
  console.log("\n=== Mk2 Plan Summary ===");
  console.log("Intent:", plan.intent);
  console.log("Plan ID:", plan.planId);
  console.log("Created At:", plan.createdAt);
  console.log("Steps:");
  plan.steps.forEach((step, i) => {
    const v = verdicts[i];
    console.log(`  [${step.id}] ${step.title} | Effect: ${step.effect} | Tool: ${step.tool}`);
    console.log(`    Verdict: ${v.decision}`);
    if (v.reasons.length) console.log(`    Reasons: ${v.reasons.join("; ")}`);
    if (v.missingEvidence.length) console.log(`    Missing Evidence: ${v.missingEvidence.join(", ")}`);
  });
  console.log("\nResults:");
  result.results.forEach((r) => {
    console.log(`  Step: ${r.stepId} | Status: ${r.status}`);
    console.log(`    Receipt: ${r.receiptPath}`);
    console.log(`    Ledger Hash: ${r.ledgerHash}`);
    if (r.output) console.log(`    Output: ${JSON.stringify(r.output)}`);
    if (r.reasons) console.log(`    Reasons: ${r.reasons.join("; ")}`);
  });
  const lastResult = result.results.at(-1);
  console.log("\nLedger head hash:", lastResult?.ledgerHash ?? "none");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(EXIT_CODE_FATAL_ERROR);
});
