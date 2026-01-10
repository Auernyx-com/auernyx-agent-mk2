export type EvidenceRequirement =
  | "USER_CONFIRMATION"
  | "FILE_PATHS_PROVIDED"
  | "WORKSPACE_OPEN"
  | "EXPLICIT_WRITE_ENABLE";

export type StepEffect = "READ_ONLY" | "WRITE" | "NETWORK" | "EXECUTE";

export type PlanStep = {
  id: string;
  title: string;
  effect: StepEffect;
  tool: string; // symbolic tool name; router maps this
  args: Record<string, unknown>;
  requiresEvidence: EvidenceRequirement[];
  rollback?: { description: string };
};

export type Plan = {
  planId: string;
  intent: string;
  createdAt: string; // ISO
  steps: PlanStep[];
};

export type PlannerInput = {
  intent: string;
  rawInput: string;
  context?: Record<string, unknown>;
};

export function createPlan(input: PlannerInput): Plan {
  // Minimum viable: treat everything as a single READ_ONLY step until you expand intent parsing.
  const now = new Date().toISOString();
  const planId = `plan_${now.replace(/[:.]/g, "-")}`;

  return {
    planId,
    intent: input.intent,
    createdAt: now,
    steps: [
      {
        id: "step_1",
        title: "Preview / analyze request (read-only)",
        effect: "READ_ONLY",
        tool: "preview.noop",
        args: { rawInput: input.rawInput, context: input.context ?? {} },
        requiresEvidence: ["WORKSPACE_OPEN"],
        rollback: { description: "No rollback needed for read-only preview." },
      },
    ],
  };
}
