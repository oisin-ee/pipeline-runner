import { Array, String } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import { match } from "effect/Result";
import * as Schema from "effect/Schema";

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
  RunnerCommandIoService,
  runValidatedRunnerCommand,
} from "../runtime/services/runner-command-io-service";
import type { OutputStream } from "../runtime/services/runner-command-io-service";
import { finalizeWorkflowLifecycle } from "../runtime/workflow-lifecycle";
import {
  parseResultWithSchema,
  requiredString,
  struct,
} from "../schema-boundary";
import { createRunnerLifecycleContextEffect } from "./lifecycle-context";
import type { RunnerLifecycleContext } from "./lifecycle-context";
import {
  requireScheduleFileForFileSource,
  scheduleSourceFields,
} from "./schedule-source-options";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;
const ARGO_STOP_SHUTDOWN_MESSAGE_PATTERNS = [
  /^Stopped with strategy 'Stop'$/u,
  /^workflow shutdown with strategy:\s+Stop$/u,
];

const argoFailureSchema = struct({
  message: Schema.optional(Schema.String),
});

const argoFailures = Schema.mutable(Schema.Array(argoFailureSchema));
const argoFailuresJson = Schema.fromJsonString(argoFailures);

type ArgoFailure = typeof argoFailureSchema.Type;

class RunnerFinalizeError extends Schema.TaggedErrorClass<RunnerFinalizeError>()(
  "RunnerFinalizeError",
  {
    message: Schema.String,
  }
) {}

const errorWithMessage = struct({
  message: Schema.String,
});

const isErrorWithMessage = Schema.is(errorWithMessage);
const isRunnerCommandPayloadValidationError = Schema.is(
  RunnerCommandPayloadValidationError
);

const errorMessage = (error: unknown): string =>
  isErrorWithMessage(error) ? error.message : globalThis.String(error);

const isValidationExitError = (error: unknown): boolean =>
  isRunnerCommandPayloadValidationError(error) || Schema.isSchemaError(error);

const dynamicFinalizerRunStatus = (input: {
  failed?: RuntimeNodeResult;
  missing: string[];
  outcome: PipelineRuntimeResult["outcome"];
}): MokaRunStatus => {
  if (input.outcome === "CANCELLED") {
    return "aborted";
  }
  if (input.failed) {
    return "failed";
  }
  return Array.match(input.missing, {
    onEmpty: () => "passed",
    onNonEmpty: () => "blocked",
  });
};

const isArgoStopShutdownFailure = (failure: ArgoFailure): boolean => {
  const message = failure.message ?? "";
  return ARGO_STOP_SHUTDOWN_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(message)
  );
};

const parseArgoFailures = (
  rawFailures: string
):
  | { data: ArgoFailure[]; success: true }
  | { message: string; success: false } => {
  const result = parseResultWithSchema(argoFailuresJson, rawFailures, {
    onExcessProperty: "preserve",
  });
  return result.ok
    ? { data: result.value, success: true }
    : {
        message: `Argo failures must be workflow.failures JSON: ${result.error.message}`,
        success: false,
      };
};

const argoFailuresFromJson = (
  rawFailures: Option.Option<string>
): ArgoFailure[] =>
  Option.match(rawFailures, {
    onNone: () => [],
    onSome: (value) => {
      const result = parseArgoFailures(value);
      if (result.success) {
        return result.data;
      }
      throw new RunnerFinalizeError({ message: result.message });
    },
  });

const hasArgoStopShutdownFailure = (
  rawFailures: Option.Option<string>
): boolean => argoFailuresFromJson(rawFailures).some(isArgoStopShutdownFailure);

const finalizerOutcome = (input: {
  argoFailures: Option.Option<string>;
  argoStatus: string;
}): PipelineRuntimeResult["outcome"] => {
  if (hasArgoStopShutdownFailure(input.argoFailures)) {
    return "CANCELLED";
  }
  return input.argoStatus === "Succeeded" ? "PASS" : "FAIL";
};

const validateArgoFailures = (options: { argoFailures?: string }) =>
  Option.match(Option.fromUndefinedOr(options.argoFailures), {
    onNone: () => true,
    onSome: (failures) => {
      if (String.isEmpty(failures)) {
        return true;
      }
      const result = parseArgoFailures(failures);
      return result.success
        ? true
        : { issue: result.message, path: ["argoFailures"] };
    },
  });

const isFilterIssue = (
  result: boolean | { issue: string; path: readonly PropertyKey[] }
): result is { issue: string; path: readonly PropertyKey[] } => result !== true;

const fetchLike = Schema.declare<FetchLike>(
  (value): value is FetchLike => typeof value === "function"
);
const outputStream = Schema.declare<OutputStream>(isOutputStream);

const runnerFinalizeOptionsSchema = struct({
  argoFailures: Schema.optional(requiredString),
  argoStatus: requiredString,
  cwd: Schema.optional(requiredString),
  env: Schema.optional(
    Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))
  ),
  fetch: Schema.optional(fetchLike),
  payloadFile: requiredString,
  ...scheduleSourceFields,
  stderr: Schema.optional(outputStream),
}).check(
  Schema.makeFilter(
    (options) => {
      const issues = [
        validateArgoFailures(options),
        requireScheduleFileForFileSource(options),
      ].filter(isFilterIssue);
      return Array.match(issues, {
        onEmpty: () => true,
        onNonEmpty: (values) => values,
      });
    },
    {
      description:
        "Finalize options must reference valid failure and schedule sources.",
      identifier: "RunnerFinalizeOptionsConsistency",
      title: "Runner finalize options consistency",
    }
  )
);

export type RunnerFinalizeOptions = typeof runnerFinalizeOptionsSchema.Encoded;

const finalizerRunIdEffect = (
  context: RunnerLifecycleContext["context"]
): Effect.Effect<string, RunnerFinalizeError> =>
  Option.match(
    Option.filter(Option.fromUndefinedOr(context.runId), String.isNonEmpty),
    {
      onNone: () =>
        Effect.fail(
          new RunnerFinalizeError({
            message: "Dynamic finalizer requires context.runId.",
          })
        ),
      onSome: Effect.succeed,
    }
  );

interface FinalizerExecutionResult {
  completed: RuntimeNodeResult[];
  failure?: RuntimeFailure;
  outcome: PipelineRuntimeResult["outcome"];
}

const passedFinalizerExecution = (
  completed: RuntimeNodeResult[]
): FinalizerExecutionResult => ({
  completed,
  outcome: "PASS",
});

const missingFinalizerExecution = (
  completed: RuntimeNodeResult[],
  missingNodeIds: readonly string[]
): FinalizerExecutionResult => ({
  completed,
  failure: {
    evidence: [`missing durable results: ${missingNodeIds.join(", ")}`],
    gate: "dynamic-finalizer",
    reason: "dynamic run finished before all DB-scheduled nodes passed",
  },
  outcome: "FAIL",
});

const failedFinalizerExecution = (
  completed: RuntimeNodeResult[],
  failed: RuntimeNodeResult
): FinalizerExecutionResult => ({
  completed,
  failure: {
    evidence: failed.evidence,
    gate: failed.nodeId,
    nodeId: failed.nodeId,
    reason: `node '${failed.nodeId}' failed`,
  },
  outcome: "FAIL",
});

const finalizerExecutionEffect = (input: {
  argoFailures?: string;
  argoStatus: string;
  context: RunnerLifecycleContext["context"];
  scheduleSource: "db" | "file";
  worktreePath: string;
}): Effect.Effect<FinalizerExecutionResult, unknown> => {
  const outcome = finalizerOutcome({
    argoFailures: Option.fromNullishOr(input.argoFailures),
    argoStatus: input.argoStatus,
  });
  if (input.scheduleSource !== "db") {
    return Effect.succeed({
      completed: [],
      outcome,
    });
  }
  return Effect.scoped(
    Effect.gen(function* effectBody() {
      const runId = yield* finalizerRunIdEffect(input.context);
      const durableStore = yield* resolveDurableStore(loadMokaDbUrl(), runId);
      const completed = input.context.plan.topologicalOrder.flatMap((node) => {
        const record = durableStore.get(runId, node.id);
        return Option.isSome(record) ? [record.value.result] : [];
      });
      const failed = completed.find((result) => result.status === "failed");
      const missing = input.context.plan.topologicalOrder
        .map((node) => node.id)
        .filter((nodeId) => Option.isNone(durableStore.get(runId, nodeId)));
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
        return failedFinalizerExecution(completed, failed);
      }
      return Array.match(missing, {
        onEmpty: () => passedFinalizerExecution(completed),
        onNonEmpty: (missingNodeIds) =>
          missingFinalizerExecution(completed, missingNodeIds),
      });
    })
  );
};

const finalizeErrorExitCode = (error: unknown, stderr: OutputStream) => {
  const message = errorMessage(error);
  stderr.write(`${message}\n`);
  return isValidationExitError(error) ? EXIT_VALIDATION : EXIT_STARTUP;
};

const runnerFinalizeRuntimeResult = (
  context: RunnerLifecycleContext["context"],
  outcome: PipelineRuntimeResult["outcome"],
  nodes: PipelineRuntimeResult["nodes"],
  failure?: RuntimeFailure
): PipelineRuntimeResult => ({
  agentInvocations: [],
  failureDetails: failure ? [failure] : [],
  gates: context.gates,
  hookFailures: context.hookFailures,
  nodeStates: R.fromEntries(context.nodeStateStore.nodeStates),
  nodes,
  outcome,
  plan: context.plan,
  structuredOutputs: [...context.nodeStateStore.structuredOutputs],
});

const runRunnerFinalizeEffect = (
  options: RunnerFinalizeOptions,
  stderr: OutputStream
): Effect.Effect<number, never, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const result = yield* Effect.result(
      Effect.gen(function* runnerFinalizeProgram() {
        const io = yield* RunnerCommandIoService;
        const { compiled, context, payload, sink, worktreePath } =
          yield* createRunnerLifecycleContextEffect(options);
        const execution = yield* finalizerExecutionEffect({
          argoFailures: options.argoFailures,
          argoStatus: options.argoStatus,
          context,
          scheduleSource: options.scheduleSource ?? "file",
          worktreePath,
        });
        const lifecycle = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await finalizeWorkflowLifecycle(
              {
                buildResult: (outcome, nodes, failure) =>
                  runnerFinalizeRuntimeResult(context, outcome, nodes, failure),
                runWorkflowHook: async (event, failure) =>
                  Option.fromNullishOr(
                    await dispatchHooks(context, event, failure)
                  ),
              },
              execution
            ),
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
      })
    );
    return match(result, {
      onFailure: (error) => finalizeErrorExitCode(error, stderr),
      onSuccess: (exitCode) => exitCode,
    });
  });

export const runRunnerFinalize = async (
  rawOptions: Partial<RunnerFinalizeOptions> = {}
): Promise<number> =>
  await runValidatedRunnerCommand(
    runnerFinalizeOptionsSchema,
    rawOptions,
    runRunnerFinalizeEffect
  );
