import { z } from "zod";
import { compileArgoExecutionGraph } from "../argo-graph";
import { promoteFinalRef } from "../run-state/git-refs";
import { RunnerCommandPayloadValidationError } from "../runner-command-contract";
import type {
  PipelineRuntimeResult,
  RuntimeFailure,
} from "../runtime/contracts";
import { dispatchHooks } from "../runtime/hooks";
import { finalizeWorkflowLifecycle } from "../runtime/workflow-lifecycle";
import { createRunnerLifecycleContext } from "./lifecycle-context";

interface OutputStream {
  write(chunk: string | Uint8Array): boolean;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const runnerFinalizeOptionsSchema = z
  .object({
    argoStatus: z.string().min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    fetch: z
      .custom<FetchLike>((value) => typeof value === "function")
      .optional(),
    payloadFile: z.string().min(1),
    scheduleFile: z.string().min(1),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
  })
  .strict();

export type RunnerFinalizeOptions = z.input<typeof runnerFinalizeOptionsSchema>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

export async function runRunnerFinalize(
  rawOptions: Partial<RunnerFinalizeOptions> = {}
): Promise<number> {
  const parsedOptions = runnerFinalizeOptionsSchema.safeParse(rawOptions);
  const stderr = rawOptions.stderr ?? process.stderr;
  if (!parsedOptions.success) {
    stderr.write(`${parsedOptions.error.message}\n`);
    return EXIT_VALIDATION;
  }
  const options = parsedOptions.data;
  try {
    const { compiled, context, payload, sink, worktreePath } =
      await createRunnerLifecycleContext(options);
    const lifecycle = await finalizeWorkflowLifecycle(
      {
        buildResult: (outcome, nodes, failure) =>
          runnerFinalizeRuntimeResult(context, outcome, nodes, failure),
        runWorkflowHook: (event, failure) =>
          dispatchHooks(context, event, failure),
      },
      {
        completed: [],
        outcome: options.argoStatus === "Succeeded" ? "PASS" : "FAIL",
      }
    );
    if (lifecycle.result.outcome === "PASS") {
      const graph = compileArgoExecutionGraph(compiled.plan);
      await promoteFinalRef({
        committer: compiled.config.runner_command.git.committer,
        payload,
        sourceNodeIds: graph.terminalNodeIds,
        worktreePath,
      });
    }
    sink.recordFinalResult(lifecycle.result.outcome, payload.workflow.id);
    await flushAndReport(sink, stderr);
    return lifecycle.result.outcome === "PASS" ? EXIT_PASS : EXIT_FAIL;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return error instanceof RunnerCommandPayloadValidationError ||
      error instanceof z.ZodError
      ? EXIT_VALIDATION
      : EXIT_STARTUP;
  }
}

function runnerFinalizeRuntimeResult(
  context: Awaited<ReturnType<typeof createRunnerLifecycleContext>>["context"],
  outcome: PipelineRuntimeResult["outcome"],
  nodes: PipelineRuntimeResult["nodes"],
  failure?: RuntimeFailure
): PipelineRuntimeResult {
  return {
    agentInvocations: [],
    failureDetails: failure ? [failure] : [],
    gates: context.gates,
    hookFailures: context.hookFailures,
    nodeStates: context.nodeStateStore.toNodeStateRecord(),
    nodes,
    outcome,
    plan: context.plan,
    structuredOutputs: context.nodeStateStore.structuredOutputList(),
  };
}

function isOutputStream(value: unknown): value is OutputStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "write" in value &&
    typeof value.write === "function"
  );
}

async function flushAndReport(
  sink: Awaited<ReturnType<typeof createRunnerLifecycleContext>>["sink"],
  stderr: OutputStream
): Promise<void> {
  try {
    await sink.flush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`runner event flush failed: ${message}\n`);
  }
}
