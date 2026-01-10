// Execution Plane for Mk2
// Stubs for external execution boundaries

import type { PlanStep } from "./planner";

export type ExecutionResult =
  | { type: "external"; message: string }
  | { type: "read-only"; message: string }
  | { type: "denied"; message: string };

export function executeStep(step: PlanStep): ExecutionResult {
  if (step.type === "READ_ONLY") {
    return { type: "read-only", message: `Step ${step.id} is read-only.` };
  }
  if (step.type === "HIGH_RISK") {
    return { type: "denied", message: `Step ${step.id} is denied locally.` };
  }
  return { type: "external", message: `Step ${step.id} would be executed externally.` };
}
