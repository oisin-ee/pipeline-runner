import { Effect } from "effect";
import { z } from "zod";
import { compileArgoExecutionGraph } from "../argo-graph";
import { RunnerCommandPayloadValidationError } from "../runner-command-contract";
import type {
  PipelineRuntimeResult,
  RuntimeFailure,
} from "../runtime/contracts";
import { dispatchHooks } from "../runtime/hooks";
import {
  flushAndReport,
  isOutputStream,
  type OutputStream,
  RunnerCommandIoService,
  runValidatedRunnerCommand,
} from "../runtime/services/runner-command-io-service";
import { finalizeWorkflowLifecycle } from "../runtime/workflow-lifecycle";
import {
  createRunnerLifecycleContextEffect,
  type RunnerLifecycleContext,
} from "./lifecycle-context";

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

export function runRunnerFinalize(
  rawOptions: Partial<RunnerFinalizeOptions> = {}
): Promise<number> {
  return runValidatedRunnerCommand(
    runnerFinalizeOptionsSchema,
    rawOptions,
    runRunnerFinalizeEffect
  );
}

function runRunnerFinalizeEffect(
  options: RunnerFinalizeOptions,
  stderr: OutputStream
): Effect.Effect<number, never, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    const { compiled, context, payload, sink, worktreePath } =
      yield* createRunnerLifecycleContextEffect(options);
    const lifecycle = yield* Effect.tryPromise({
      try: () =>
        finalizeWorkflowLifecycle(
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
        ),
      catch: (error) => error,
    });
    if (lifecycle.result.outcome === "PASS") {
      const graph = compileArgoExecutionGraph(compiled.plan);
      yield* io.promoteFinalRef({
        committer: compiled.config.runner_command.git.committer,
        payload,
        sourceNodeIds: graph.terminalNodeIds,
        worktreePath,
      });
    }
    sink.recordFinalResult(lifecycle.result.outcome, payload.workflow.id);
    yield* flushAndReport(sink, stderr);
    return lifecycle.result.outcome === "PASS" ? EXIT_PASS : EXIT_FAIL;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => finalizeErrorExitCode(error, stderr))
    )
  );
}

function finalizeErrorExitCode(error: unknown, stderr: OutputStream) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  return error instanceof RunnerCommandPayloadValidationError ||
    error instanceof z.ZodError
    ? EXIT_VALIDATION
    : EXIT_STARTUP;
}

function runnerFinalizeRuntimeResult(
  context: RunnerLifecycleContext["context"],
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
