import { PlanStep } from "./planner.js";

export type ExecutionResult = {
  ok: true;
  output: unknown;
} | {
  ok: false;
  error: string;
};

export async function executeStepExternally(step: PlanStep): Promise<ExecutionResult> {
  // MV discipline: you are NOT allowed to “just do it” here.
  // This is the stub boundary where Foundry MCP (or other plane) will be called later.
  return {
    ok: true,
    output: {
      note: "Execution plane stub: no external tool invoked.",
      step: { id: step.id, tool: step.tool, effect: step.effect },
      args: step.args,
    },
  };
}
