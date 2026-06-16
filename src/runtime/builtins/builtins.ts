import {
  runFallow,
  runJscpd,
  runLint,
  runSemgrep,
  runTests,
  runTypecheck,
} from "../../gates";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { executeDrainMergeBuiltin } from "../drain-merge";
import { executeSelectCandidateBuiltin } from "../select-candidate/select-candidate";

interface BuiltinCommandResult {
  command?: string;
  exitCode: number;
  output: string;
}

export async function executeBuiltin(
  builtin: string,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  switch (builtin) {
    case "drain-merge":
      return executeDrainMergeBuiltin(context, node);
    case "select-candidate":
      return executeSelectCandidateBuiltin(context, node);
    case "test": {
      const result = await runTests(context.worktreePath, context.signal);
      return {
        evidence: [
          ...builtinCommandEvidence("test", result),
          ...result.failingTests,
        ],
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "typecheck": {
      const result = await runTypecheck(context.worktreePath, context.signal);
      return {
        evidence: builtinCommandEvidence("typecheck", result),
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "lint": {
      const result = await runLint(context.worktreePath, context.signal);
      return {
        evidence: builtinCommandEvidence("lint", result),
        exitCode: result.exitCode,
        output: result.output,
      };
    }
    case "fallow": {
      const result = await runFallow(context.worktreePath, context.signal);
      return {
        evidence: builtinCommandEvidence("fallow", result),
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
      const result = await runSemgrep(
        context.worktreePath,
        context.signal,
        runtimeChangedFiles(context)
      );
      return {
        evidence: builtinCommandEvidence("semgrep", result),
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

function runtimeChangedFiles(context: RuntimeContext): string[] {
  return [...new Set(context.nodeStateStore.changedFilesForAllNodes())].sort();
}

function builtinCommandEvidence(
  builtin: string,
  result: BuiltinCommandResult
): string[] {
  const command = result.command ? `: ${result.command}` : "";
  return [
    `builtin '${builtin}' exited ${result.exitCode}${command}`,
    result.output || `builtin '${builtin}' produced no output`,
  ];
}
