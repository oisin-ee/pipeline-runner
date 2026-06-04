import { runJscpd, runSemgrep, runTests, runTypecheck } from "../../gates";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { executeDrainMergeBuiltin } from "../drain-merge";

export async function executeBuiltin(
  builtin: string,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  switch (builtin) {
    case "drain-merge":
      return executeDrainMergeBuiltin(context, node);
    case "test": {
      const result = await runTests(context.worktreePath, context.signal);
      return {
        evidence: [result.output, ...result.failingTests],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "typecheck": {
      const result = await runTypecheck(context.worktreePath, context.signal);
      return {
        evidence: [result.output],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "duplication": {
      const result = await runJscpd(context.worktreePath, context.signal);
      return {
        evidence: result.violations.map((violation) => violation.message),
        exitCode: result.violations.length === 0 ? 0 : 1,
        output: JSON.stringify(result.violations),
      };
    }
    case "semgrep": {
      const result = await runSemgrep(context.worktreePath, context.signal);
      return {
        evidence: [result.output],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    default:
      return {
        evidence: [`unsupported builtin '${builtin}'`],
        exitCode: 1,
        output: "",
      };
  }
}
