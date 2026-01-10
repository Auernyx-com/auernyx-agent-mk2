import { Plan } from "./planner.js";
import { PolicySnapshot, PolicyVerdict, mustRefuse } from "./policy.js";
import { writeReceiptAndLedger } from "./receipts.js";
import { executeStepExternally } from "./executionPlane.js";

export type RouterResult = {
  ok: boolean;
  results: Array<{
    stepId: string;
    status: "REFUSED" | "EXECUTED";
    receiptPath: string;
    ledgerHash: string;
    output?: unknown;
    reasons?: string[];
  }>;
};

export async function runPlan(
  workspaceRoot: string,
  plan: Plan,
  snapshot: PolicySnapshot,
  verdicts: PolicyVerdict[],
): Promise<RouterResult> {
  const results: RouterResult["results"] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const verdict = verdicts[i];

    if (mustRefuse(verdict)) {
      const written = writeReceiptAndLedger(workspaceRoot, plan, step, snapshot, verdict, "REFUSED");
      results.push({
        stepId: step.id,
        status: "REFUSED",
        receiptPath: written.receiptPath,
        ledgerHash: written.ledgerHash,
        reasons: verdict.reasons,
      });
      continue;
    }

    const exec = await executeStepExternally(step);
    if (!exec.ok) {
      // Treat execution error as refusal-equivalent for now; still receipt it.
      const errorVerdict: PolicyVerdict = {
        decision: "DENY",
        reasons: [`Execution failed: ${exec.error}`],
        missingEvidence: [],
      };
      const written = writeReceiptAndLedger(workspaceRoot, plan, step, snapshot, errorVerdict, "REFUSED");
      results.push({
        stepId: step.id,
        status: "REFUSED",
        receiptPath: written.receiptPath,
        ledgerHash: written.ledgerHash,
        reasons: errorVerdict.reasons,
      });
      continue;
    }

    const written = writeReceiptAndLedger(workspaceRoot, plan, step, snapshot, verdict, "EXECUTED", exec.output);
    results.push({
      stepId: step.id,
      status: "EXECUTED",
      receiptPath: written.receiptPath,
      ledgerHash: written.ledgerHash,
      output: exec.output,
    });
  }

  return { ok: results.every((r) => r.status === "EXECUTED"), results };
}
