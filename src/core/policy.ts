import { Plan, PlanStep } from "./planner.js";

export type PolicyDecision = "ALLOW" | "DENY";
export type PolicyVerdict = {
  decision: PolicyDecision;
  reasons: string[];
  missingEvidence: string[];
};

export type ActivePolicy = {
  version: string;
  denyByDefault: boolean;
  protectedPaths: string[];
  allowWrites: boolean;
};

export type PolicySnapshot = {
  policy: ActivePolicy;
  capturedAt: string; // ISO
};

export function loadActivePolicy(): ActivePolicy {
  // MV: hard-coded default. Later: load from active.policy.json
  return {
    version: "0.1.0",
    denyByDefault: true,
    protectedPaths: ["receipts/", "ledger/"],
    allowWrites: false, // default deny
  };
}

export function snapshotPolicy(policy: ActivePolicy): PolicySnapshot {
  return { policy, capturedAt: new Date().toISOString() };
}

export function evaluatePlan(plan: Plan, snapshot: PolicySnapshot, evidence: Set<string>): PolicyVerdict[] {
  return plan.steps.map((s) => evaluateStep(s, snapshot, evidence));
}

export function evaluateStep(step: PlanStep, snapshot: PolicySnapshot, evidence: Set<string>): PolicyVerdict {
  const missing = step.requiresEvidence.filter((e) => !evidence.has(e));
  const reasons: string[] = [];

  if (missing.length) reasons.push(`Missing evidence: ${missing.join(", ")}`);

  // deny-by-default for anything not READ_ONLY
  if (snapshot.policy.denyByDefault && step.effect !== "READ_ONLY") {
    reasons.push(`Denied by default: step effect is ${step.effect}`);
  }

  if (step.effect === "WRITE" && !snapshot.policy.allowWrites) {
    reasons.push("Writes disabled by policy (allowWrites=false)");
  }

  const decision: PolicyDecision = reasons.length ? "DENY" : "ALLOW";
  return { decision, reasons, missingEvidence: missing };
}

export function mustRefuse(verdict: PolicyVerdict): boolean {
  return verdict.decision === "DENY";
}
