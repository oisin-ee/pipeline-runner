import { Effect } from "effect";
import { z } from "zod";
import { compileArgoExecutionGraph } from "../argo-graph";
import { loadMokaDbUrl } from "../moka-global-config";
import type { MokaRunStatus } from "../run-control/contracts";
import { withRunControlStoreScoped } from "../run-control/run-control-store";
import { RunnerCommandPayloadValidationError } from "../runner-command-contract";
import type {
  PipelineRuntimeResult,
  RuntimeFailure,
  RuntimeNodeResult,
} from "../runtime/contracts";
import { resolveDurableStore } from "../runtime/durable-store/acquisition";
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
import {
  requireScheduleFileForFileSource,
  scheduleSourceFields,
} from "./schedule-source-options";

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
    ...scheduleSourceFields,
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
  })
  .strict()
  .superRefine(requireScheduleFileForFileSource);

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
    const execution = yield* finalizerExecutionEffect({
      argoStatus: options.argoStatus,
      scheduleSource: options.scheduleSource ?? "file",
      context,
      worktreePath,
    });
    const lifecycle = yield* Effect.tryPromise({
      try: () =>
        finalizeWorkflowLifecycle(
          {
            buildResult: (outcome, nodes, failure) =>
              runnerFinalizeRuntimeResult(context, outcome, nodes, failure),
            runWorkflowHook: (event, failure) =>
              dispatchHooks(context, event, failure),
          },
          execution
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

function finalizerExecutionEffect(input: {
  argoStatus: string;
  context: RunnerLifecycleContext["context"];
  scheduleSource: "db" | "file";
  worktreePath: string;
}): Effect.Effect<
  {
    completed: RuntimeNodeResult[];
    failure?: RuntimeFailure;
    outcome: PipelineRuntimeResult["outcome"];
  },
  unknown
> {
  if (input.scheduleSource !== "db") {
    return Effect.succeed({
      completed: [],
      outcome: input.argoStatus === "Succeeded" ? "PASS" : "FAIL",
    });
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const runId = yield* finalizerRunIdEffect(input.context);
      const durableStore = yield* resolveDurableStore(loadMokaDbUrl(), runId);
      const completed = input.context.plan.topologicalOrder.flatMap((node) => {
        const record = durableStore.get(runId, node.id);
        return record ? [record.result] : [];
      });
      const failed = completed.find((result) => result.status === "failed");
      const missing = input.context.plan.topologicalOrder
        .map((node) => node.id)
        .filter((nodeId) => !durableStore.get(runId, nodeId));
      const status = dynamicFinalizerRunStatus({ failed, missing });
      yield* withRunControlStoreScoped(input.worktreePath, (store) =>
        store.updateRunStatus({
          at: new Date().toISOString(),
          runId,
          status,
        })
      );
      if (failed) {
        return {
          completed,
          failure: {
            evidence: failed.evidence,
            gate: failed.nodeId,
            nodeId: failed.nodeId,
            reason: `node '${failed.nodeId}' failed`,
          },
          outcome: "FAIL" as const,
        };
      }
      if (missing.length > 0) {
        return {
          completed,
          failure: {
            evidence: [`missing durable results: ${missing.join(", ")}`],
            gate: "dynamic-finalizer",
            reason: "dynamic run finished before all DB-scheduled nodes passed",
          },
          outcome: "FAIL" as const,
        };
      }
      return { completed, outcome: "PASS" as const };
    })
  );
}

function dynamicFinalizerRunStatus(input: {
  failed?: RuntimeNodeResult;
  missing: string[];
}): MokaRunStatus {
  if (input.failed) {
    return "failed";
  }
  if (input.missing.length > 0) {
    return "blocked";
  }
  return "passed";
}

function finalizerRunIdEffect(
  context: RunnerLifecycleContext["context"]
): Effect.Effect<string, Error> {
  return context.runId
    ? Effect.succeed(context.runId)
    : Effect.fail(new Error("Dynamic finalizer requires context.runId."));
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
