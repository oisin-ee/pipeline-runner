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
    argoFailures: z.string().min(1).optional(),
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
  .superRefine(validateArgoFailures)
  .superRefine(requireScheduleFileForFileSource);

export type RunnerFinalizeOptions = z.input<typeof runnerFinalizeOptionsSchema>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;
const ARGO_STOP_SHUTDOWN_MESSAGE_PATTERNS = [
  /^Stopped with strategy 'Stop'$/,
  /^workflow shutdown with strategy:\s+Stop$/,
];

const argoFailureSchema = z
  .object({
    message: z.string().optional(),
  })
  .passthrough();

const argoFailuresSchema = z.array(argoFailureSchema);

type ArgoFailure = z.infer<typeof argoFailureSchema>;

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
      argoFailures: options.argoFailures,
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
    if (lifecycle.result.outcome === "CANCELLED") {
      sink.recordCancellation(payload.workflow.id);
    } else {
      sink.recordFinalResult(lifecycle.result.outcome, payload.workflow.id);
    }
    yield* flushAndReport(sink, stderr);
    return lifecycle.result.outcome === "PASS" ? EXIT_PASS : EXIT_FAIL;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => finalizeErrorExitCode(error, stderr))
    )
  );
}

function finalizerExecutionEffect(input: {
  argoFailures?: string;
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
  const outcome = finalizerOutcome(input);
  if (input.scheduleSource !== "db") {
    return Effect.succeed({
      completed: [],
      outcome,
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
      const status = dynamicFinalizerRunStatus({ failed, missing, outcome });
      yield* withRunControlStoreScoped(input.worktreePath, (store) =>
        store.updateRunStatus({
          at: new Date().toISOString(),
          runId,
          status,
        })
      );
      if (outcome === "CANCELLED") {
        return {
          completed,
          outcome,
        };
      }
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
  outcome: PipelineRuntimeResult["outcome"];
}): MokaRunStatus {
  if (input.outcome === "CANCELLED") {
    return "aborted";
  }
  if (input.failed) {
    return "failed";
  }
  if (input.missing.length > 0) {
    return "blocked";
  }
  return "passed";
}

function finalizerOutcome(input: {
  argoFailures?: string;
  argoStatus: string;
}): PipelineRuntimeResult["outcome"] {
  if (hasArgoStopShutdownFailure(input.argoFailures)) {
    return "CANCELLED";
  }
  return input.argoStatus === "Succeeded" ? "PASS" : "FAIL";
}

function hasArgoStopShutdownFailure(rawFailures: string | undefined): boolean {
  return argoFailuresFromJson(rawFailures).some(isArgoStopShutdownFailure);
}

function argoFailuresFromJson(rawFailures: string | undefined): ArgoFailure[] {
  if (!rawFailures) {
    return [];
  }
  const result = parseArgoFailures(rawFailures);
  if (result.success) {
    return result.data;
  }
  throw new z.ZodError([
    {
      code: "custom",
      message: result.message,
      path: ["argoFailures"],
    },
  ]);
}

function isArgoStopShutdownFailure(failure: ArgoFailure): boolean {
  const message = failure.message ?? "";
  return ARGO_STOP_SHUTDOWN_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(message)
  );
}

function validateArgoFailures(
  options: { argoFailures?: string },
  ctx: z.RefinementCtx
): void {
  if (!options.argoFailures) {
    return;
  }
  const result = parseArgoFailures(options.argoFailures);
  if (!result.success) {
    ctx.addIssue({
      code: "custom",
      message: result.message,
      path: ["argoFailures"],
    });
  }
}

function parseArgoFailures(
  rawFailures: string
):
  | { data: ArgoFailure[]; success: true }
  | { message: string; success: false } {
  try {
    const parsed: unknown = JSON.parse(rawFailures);
    const result = argoFailuresSchema.safeParse(parsed);
    return result.success
      ? { data: result.data, success: true }
      : {
          message: `Argo failures must be workflow.failures JSON: ${result.error.message}`,
          success: false,
        };
  } catch (error) {
    return {
      message: `Argo failures must be workflow.failures JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      success: false,
    };
  }
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
