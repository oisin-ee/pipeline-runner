import { resolve } from "node:path";

import type { Scope } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import pino from "pino";

import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import { loadMokaDbUrl } from "../moka-global-config";
import { findPlannedNode } from "../planned-node";
import { indexPlannedNodesById, resolveExecutableDependencyIds } from "../planning/dependency-refs";
import { compileScheduleArtifact, parseScheduleArtifact } from "../planning/generate";
import { readPersistedScheduleEffect } from "../run-control/next-node";
import { resolveRunControlStore } from "../run-control/run-control-store";
import type { RunControlStore } from "../run-control/run-control-store";
import { createRunStoreRuntimeReporter } from "../run-control/runtime-reporter";
import type { RunStoreRuntimeReporter } from "../run-control/runtime-reporter";
import {
  parseRunnerCommandPayload,
  RunnerCommandPayloadValidationError,
  resolveRunnerEventSinkAuthToken,
} from "../runner-command-contract";
import type { RunnerTask } from "../runner-command-contract";
import { createRunnerEventSink } from "../runner-event-sink";
import type { PipelineRuntimeEvent, RuntimeNodeResult } from "../runtime/contracts";
import { resolveDurableStore } from "../runtime/durable-store/acquisition";
import type { DurableRunStore } from "../runtime/durable-store/durable-store";
import { EXIT_INFRA } from "../runtime/exit-codes";
import { RunnerCommandIoService, RunnerCommandIoServiceLive } from "../runtime/services/runner-command-io-service";
import { recordNodeResult } from "../runtime/step/step-node";
import { parseResultWithSchema, requiredString, struct } from "../schema-boundary";
import { requireScheduleFileForFileSource, scheduleSourceFields } from "./schedule-source-options";
import { DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH, readRunnerTaskDescriptorEffect } from "./task-descriptor";

interface OutputStream {
  write(chunk: string | Uint8Array): void;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * PIPE-94.6: the two durable stores the runner persists each node result
 * through. `durableStore` carries the canonical `(runId, nodeId)` node record
 * (results — drives `moka next node`/`status`/`resume`); `runControlStore`
 * carries the event-sourced manifest the run-control surface reads for status.
 */
interface RunnerDurablePersistence {
  readonly durableStore: DurableRunStore;
  readonly runControlStore: RunControlStore;
}

/**
 * PIPE-94.6: injectable override for durable-store resolution (mirrors PIPE-94.5
 * `upsertRunRecord`). Returns the resolved stores, or `undefined` when no
 * durable substrate is configured for this pod. Tests inject in-memory/file
 * stores without touching `loadMokaDbUrl` or Postgres.
 */
type ResolveRunnerPersistence = (context: {
  runId: string;
  worktreePath: string;
}) => Effect.Effect<Option.Option<RunnerDurablePersistence>, unknown, Scope.Scope>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

/**
 * Map a finished node result to the runner process exit code. A passed node is
 * 0; an infra-classed failure (agent timeout/idle/provider, EXIT_INFRA) exits 70
 * so argo's retryStrategy reschedules a fresh pod; any other failure stays 1
 * (a genuine task failure argo must not retry).
 */
export const nodeProcessExitCode = (result: RuntimeNodeResult): number => {
  if (result.status === "passed") {
    return EXIT_PASS;
  }
  return result.exitCode === EXIT_INFRA ? EXIT_INFRA : EXIT_FAIL;
};

// Resolve the planned node this Argo task targets, failing with the runner's
// validation messages when the payload workflow disagrees with the schedule or
// the task isn't in the plan. Extracted so runRunnerCommandEffect stays within
// the complexity budget.
const resolveRunnerTargetNode = (
  payload: ReturnType<typeof parseRunnerCommandPayload>,
  compiled: ReturnType<typeof compileScheduleArtifact>,
  descriptor: { nodeId: string },
): Effect.Effect<NonNullable<ReturnType<typeof findPlannedNode>>, unknown> =>
  Effect.gen(function* effectBody() {
    if (payload.workflow.id !== compiled.workflowId) {
      return yield* Effect.fail(
        new Error(
          `Runner payload workflow '${payload.workflow.id}' does not match schedule workflow '${compiled.workflowId}'`,
        ),
      );
    }
    const node = findPlannedNode(compiled.plan.topologicalOrder, descriptor.nodeId);
    if (!node) {
      return yield* Effect.fail(
        new Error(`Argo task '${descriptor.nodeId}' is not declared in workflow '${compiled.workflowId}'`),
      );
    }
    return node;
  });

const runnerTaskDescriptorEffect = (
  options: RunnerCommandOptions,
): Effect.Effect<{ nodeId: string }, unknown, RunnerCommandIoService> => {
  if (options.nodeId !== undefined && options.nodeId.length > 0) {
    return Effect.succeed({ nodeId: options.nodeId });
  }
  return readRunnerTaskDescriptorEffect(options.taskDescriptorFile ?? DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH);
};

const persistedRunnerScheduleYamlEffect = (
  payload: ReturnType<typeof parseRunnerCommandPayload>,
  persistence: Option.Option<RunnerDurablePersistence>,
): Effect.Effect<string, unknown> =>
  Option.match(persistence, {
    onNone: () =>
      Effect.fail(
        new Error(`Run ${payload.run.id} cannot read schedule from DB because durable persistence is unavailable.`),
      ),
    onSome: (stores) => readPersistedScheduleEffect(stores.runControlStore, payload.run.id),
  });

const runnerScheduleYamlEffect = (input: {
  options: RunnerCommandOptions;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  persistence: Option.Option<RunnerDurablePersistence>;
}): Effect.Effect<string, unknown, RunnerCommandIoService> => {
  if (input.options.scheduleSource === "db") {
    return persistedRunnerScheduleYamlEffect(input.payload, input.persistence);
  }
  return Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    return yield* io.readText(input.options.scheduleFile ?? "");
  });
};

const scheduleSourceLabel = (options: RunnerCommandOptions): string =>
  options.scheduleSource === "db" ? "persisted schedule" : (options.scheduleFile ?? "schedule.yaml");

const defaultRunnerPersistenceResolver =
  (logger: pino.Logger): ResolveRunnerPersistence =>
  ({ runId, worktreePath }) =>
    Effect.gen(function* effectBody() {
      const dbUrl = loadMokaDbUrl();
      if (dbUrl === undefined) {
        logger.info(
          { phase: "durable.persist", runId, status: "skip" },
          "durable.persist skipped — db.url not configured",
        );
        return Option.none();
      }
      const durableStore = yield* resolveDurableStore(dbUrl, runId);
      const runControlStore = yield* resolveRunControlStore(dbUrl, worktreePath);
      return Option.some({ durableStore, runControlStore });
    });

const errorMessageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * PIPE-94.6: resolve the durable stores for in-pod persistence.
 *
 * Guard contract (mirrors PIPE-94.5 lifecycle):
 *  - injected override present → delegate (tests / custom impls);
 *  - db.url absent → log the deliberate skip + return `undefined` (no substrate);
 *  - store resolution fails (e.g. Postgres unreachable) → log + return
 *    `undefined` so the node still executes and returns its real exit code.
 * Never fails the runner.
 */
const resolveRunnerPersistenceEffect = (
  override: Option.Option<ResolveRunnerPersistence>,
  context: { runId: string; worktreePath: string },
  logger: pino.Logger,
): Effect.Effect<Option.Option<RunnerDurablePersistence>, never, Scope.Scope> => {
  const resolver = Option.getOrElse(override, () => defaultRunnerPersistenceResolver(logger));
  return resolver(context).pipe(
    Effect.catch((error) =>
      Effect.sync((): Option.Option<RunnerDurablePersistence> => {
        logger.error(
          {
            error: errorMessageOf(error),
            phase: "durable.persist",
            runId: context.runId,
            status: "resolve-failed",
          },
          "durable.persist resolve failed — node executes without persistence",
        );
        return Option.none();
      }),
    ),
  );
};

const recordDurableNodeResultEffect = (
  store: DurableRunStore,
  node: { nodeId: string; result: RuntimeNodeResult; runId: string },
  logger: pino.Logger,
): Effect.Effect<void> =>
  Effect.try({
    catch: (error) => error,
    try: () => {
      recordNodeResult({ result: node.result, runId: node.runId, store });
    },
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.error(
          {
            error: errorMessageOf(error),
            nodeId: node.nodeId,
            phase: "durable.persist",
            status: "record-failed",
          },
          "durable.persist record failed — exit code unchanged",
        );
      }),
    ),
  );

const flushRunStoreReporterEffect = (
  runStoreReporter: Option.Option<RunStoreRuntimeReporter>,
  node: { nodeId: string; runId: string },
  logger: pino.Logger,
): Effect.Effect<void> =>
  Option.match(runStoreReporter, {
    onNone: () => Effect.void,
    onSome: (reporter) =>
      reporter.flushEffect().pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.error(
              {
                error: errorMessageOf(error),
                nodeId: node.nodeId,
                phase: "node.status.persist",
                status: "flush-failed",
              },
              "node.status.persist flush failed — exit code unchanged",
            );
          }),
        ),
      ),
  });

/**
 * PIPE-94.6: persist the terminal node result. The DurableRunStore write goes
 * through the step-node core's canonical {@link recordNodeResult} (the SAME path
 * `stepNode`/`submit-result` use — runner-command is now a real caller of that
 * core, not an island). The run-control node status was already projected during
 * execution by the wrapped reporter; flushing it here drains those writes.
 * No-op when no durable substrate is configured.
 */
const persistNodeResultEffect = (
  persistence: Option.Option<RunnerDurablePersistence>,
  runStoreReporter: Option.Option<RunStoreRuntimeReporter>,
  node: { nodeId: string; result: RuntimeNodeResult; runId: string },
  logger: pino.Logger,
): Effect.Effect<void> =>
  Option.match(persistence, {
    onNone: () => Effect.void,
    onSome: (stores) =>
      Effect.gen(function* effectBody() {
        logger.info({ nodeId: node.nodeId, phase: "durable.persist", status: "start" }, "durable.persist start");
        yield* recordDurableNodeResultEffect(stores.durableStore, node, logger);
        yield* flushRunStoreReporterEffect(runStoreReporter, node, logger);
        logger.info({ nodeId: node.nodeId, phase: "durable.persist", status: "finish" }, "durable.persist finish");
      }),
  });

const attemptSync = <T>(try_: () => T): Effect.Effect<T, unknown> => Effect.try({ catch: (error) => error, try: try_ });

const runnerCommandErrorExitCode = (error: unknown, logger: pino.Logger) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ error: message, phase: "runner-command" }, message);
  return error instanceof RunnerCommandPayloadValidationError || error instanceof Schema.SchemaError
    ? EXIT_VALIDATION
    : EXIT_STARTUP;
};

const prepareOpencodeCredentialsPhase = (
  logger: pino.Logger,
  reason?: "after-setup",
): Effect.Effect<void, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    logger.info(
      {
        phase: "opencode.credentials.prepare",
        ...(reason ? { reason } : {}),
        status: "start",
      },
      "opencode.credentials.prepare start",
    );
    const credentialsPrep = yield* io.prepareOpencodeCredentials();
    logger.info(
      {
        brokerConfigured: credentialsPrep.brokerConfigured,
        phase: "opencode.credentials.prepare",
        ...(reason ? { reason } : {}),
        status: "finish",
      },
      "opencode.credentials.prepare finish",
    );
  });

const setupExitCode = (exitCode: Option.Option<number>): number => Option.getOrElse(exitCode, () => 1);

const SETUP_OUTPUT_TAIL = 4000;

const setupOutputTail = (output: unknown): string => {
  if (typeof output !== "string" || output.length === 0) {
    return "";
  }
  return output.length > SETUP_OUTPUT_TAIL ? output.slice(-SETUP_OUTPUT_TAIL) : output;
};

const setupCommandOutputLog = (command: string, index: number, result: { stderr?: unknown; stdout?: unknown }) => ({
  command,
  index,
  phase: "setup.command",
  status: "output",
  stderr: setupOutputTail(result.stderr),
  stdout: setupOutputTail(result.stdout),
});

const setupCommandLog = (command: string, index: number, status: "start") => ({
  command,
  index,
  phase: "setup.command",
  status,
});

const setupCommandFinishLog = (
  command: PipelineConfig["runner_command"]["environment"]["setup"][number],
  index: number,
  exitCode: number,
) => ({
  command: command.command,
  exitCode,
  index,
  phase: "setup.command",
  required: command.required,
  status: "finish",
});

const runSetupCommand = (
  command: PipelineConfig["runner_command"]["environment"]["setup"][number],
  index: number,
  options: {
    env: NodeJS.ProcessEnv;
    logger: pino.Logger;
    worktreePath: string;
  },
): Effect.Effect<void, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    const commandIndex = index + 1;
    options.logger.info(setupCommandLog(command.command, commandIndex, "start"), "setup.command start");
    const result = yield* io.runSetupCommand(command.command, command.args, {
      cwd: options.worktreePath,
      env: options.env,
    });
    const exitCode = setupExitCode(Option.fromNullishOr(result.exitCode));
    options.logger.info(setupCommandFinishLog(command, commandIndex, exitCode), "setup.command finish");
    if (exitCode !== 0) {
      // Surface the command's captured output on failure — without it a failing
      // setup command (e.g. a repo bootstrap install) is undebuggable in the pod
      // log, which only showed the exit code.
      options.logger.error(setupCommandOutputLog(command.command, commandIndex, result), "setup.command output");
    }
    if (exitCode !== 0 && command.required) {
      return yield* Effect.fail(new Error(`runner setup command '${command.command}' failed with exit ${exitCode}`));
    }
  });

const runSetupCommands = (
  commands: PipelineConfig["runner_command"]["environment"]["setup"],
  options: {
    env: NodeJS.ProcessEnv;
    logger: pino.Logger;
    worktreePath: string;
  },
): Effect.Effect<void, unknown, RunnerCommandIoService> =>
  Effect.forEach(commands.entries(), ([index, command]) => runSetupCommand(command, index, options)).pipe(
    Effect.asVoid,
  );

const logFailedTaskRun = (logger: pino.Logger, nodeId: string, result: RuntimeNodeResult): void => {
  if (result.status === "passed" && result.exitCode === 0) {
    return;
  }
  logger.error(
    {
      evidence: result.evidence,
      exitCode: result.exitCode,
      nodeId,
      output: result.output,
      phase: "task.run",
      resultStatus: result.status,
      status: "failed",
    },
    "task.run failed",
  );
};

export const runnerTaskTextEffect = (
  task: RunnerTask,
  worktreePath: string,
): Effect.Effect<string, unknown, RunnerCommandIoService> => {
  if (task.kind === "prompt") {
    return Effect.succeed(task.prompt);
  }
  if (task.path !== undefined && task.path.length > 0) {
    const taskPath = task.path;
    return Effect.gen(function* effectBody() {
      const io = yield* RunnerCommandIoService;
      return yield* io.readText(resolve(worktreePath, taskPath));
    });
  }
  return Effect.succeed([task.id, task.title].filter(Boolean).join(" "));
};

const isOutputStream = (value: unknown): value is OutputStream =>
  typeof value === "object" && value !== null && "write" in value && typeof value.write === "function";

const fetchLike = Schema.declare<FetchLike>((value): value is FetchLike => typeof value === "function");
const outputStream = Schema.declare<OutputStream>(isOutputStream);
const resolveRunnerPersistence = Schema.declare<ResolveRunnerPersistence>(
  (value): value is ResolveRunnerPersistence => typeof value === "function",
);

const runnerCommandOptionsSchema = struct({
  cwd: Schema.optional(requiredString),
  env: Schema.optional(Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))),
  fetch: Schema.optional(fetchLike),
  // PIPE-94.8: per-node resume override. Node ids listed here are re-executed
  // even when the durable store already records them PASSED — the data-driven
  // escape hatch from the default skip-already-passed resume behaviour.
  forceRerunNodeIds: Schema.optional(Schema.mutable(Schema.Array(requiredString))),
  nodeId: Schema.optional(requiredString),
  payloadFile: requiredString,
  resolvePersistence: Schema.optional(resolveRunnerPersistence),
  ...scheduleSourceFields,
  stderr: Schema.optional(outputStream),
  stdout: Schema.optional(outputStream),
  taskDescriptorFile: Schema.optional(requiredString),
}).check(
  Schema.makeFilter(requireScheduleFileForFileSource, {
    description: "File schedule source requires a schedule file path.",
    identifier: "RunnerCommandScheduleFileSource",
    title: "Runner command schedule file source",
  }),
);

export type RunnerCommandOptions = typeof runnerCommandOptionsSchema.Encoded;

const flushAndReport = (
  sink: ReturnType<typeof createRunnerEventSink>,
  logger: pino.Logger,
): Effect.Effect<void, never, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    logger.info({ phase: "event.flush", status: "start" }, "event.flush start");
    const result = yield* Effect.result(io.flushSink(sink));
    if (result._tag === "Success") {
      logger.info({ phase: "event.flush", status: "finish" }, "event.flush finish");
      return;
    }
    const error = result.failure;
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, phase: "event.flush" }, `runner event flush failed: ${message}`);
  });

/**
 * PIPE-94.8: origin-aware resume short-circuit. A remote-origin `moka resume`
 * re-submits the FULL DAG under the same runId (createRun is idempotent); each
 * runner pod checks the durable store first and no-ops any node already recorded
 * PASSED — no re-execution, no node-ref push — so re-submitting the whole graph
 * only does the remaining work while passed nodes' git refs already exist. A node
 * id in `forceRerunNodeIds` (the per-node override, default none) is re-executed
 * even when passed. Returns `true` when the node was skipped (caller exits PASS);
 * `false` to proceed with normal execution. No-op without a durable substrate.
 */
const skipAlreadyPassedNodeEffect = (input: {
  descriptorNodeId: string;
  forceRerunNodeIds: string[];
  logger: pino.Logger;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  persistence: Option.Option<RunnerDurablePersistence>;
  sink: ReturnType<typeof createRunnerEventSink>;
}): Effect.Effect<boolean, never, RunnerCommandIoService> => {
  const { descriptorNodeId, forceRerunNodeIds, logger, payload, persistence } = input;
  if (Option.isNone(persistence)) {
    return Effect.succeed(false);
  }
  if (forceRerunNodeIds.includes(descriptorNodeId)) {
    logger.info(
      { nodeId: descriptorNodeId, phase: "node.skip", status: "force-rerun" },
      "node.skip overridden — forced re-run of an already-passed node",
    );
    return Effect.succeed(false);
  }
  const record = persistence.value.durableStore.get(payload.run.id, descriptorNodeId);
  if (Option.isNone(record) || record.value.result.status !== "passed") {
    return Effect.succeed(false);
  }
  return Effect.gen(function* effectBody() {
    logger.info(
      {
        nodeId: descriptorNodeId,
        phase: "node.skip",
        status: "already-passed",
      },
      "node.skip — node already passed in durable store, no re-execution",
    );
    input.sink.recordRunnerCommandPhase("task.skip", `Skipping already-passed ${descriptorNodeId}`, {
      taskId: descriptorNodeId,
      workflowId: payload.workflow.id,
    });
    yield* flushAndReport(input.sink, logger);
    return true;
  });
};

const runRunnerCommandEffect = (
  options: RunnerCommandOptions,
  runtime: { logger: pino.Logger; stderr: OutputStream; stdout: OutputStream },
): Effect.Effect<number, never, RunnerCommandIoService | Scope.Scope> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    const { logger } = runtime;
    logger.info({ phase: "payload.load", status: "start" }, "payload.load start");
    const payloadRaw = yield* io.readText(options.payloadFile);
    const payload = yield* attemptSync(() => parseRunnerCommandPayload(payloadRaw));
    const descriptor = yield* runnerTaskDescriptorEffect(options);
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "payload.load",
        runId: payload.run.id,
        status: "finish",
        workflowId: payload.workflow.id,
      },
      "payload.load finish",
    );
    logger.info({ phase: "event.sink.configure", status: "start" }, "event.sink.configure start");
    const authToken = resolveRunnerEventSinkAuthToken({
      authTokenFile: payload.events.authTokenFile,
    });
    const sink = createRunnerEventSink({
      authHeader: payload.events.authHeader,
      authToken,
      fetch: options.fetch,
      runId: payload.run.id,
      url: payload.events.url,
    });
    logger.info({ phase: "event.sink.configure", status: "finish" }, "event.sink.configure finish");
    logger.info(
      {
        hasProvidedCwd: options.cwd !== undefined && options.cwd.length > 0,
        phase: "git.workspace.prepare",
        status: "start",
      },
      "git.workspace.prepare start",
    );
    const worktreePath = yield* io.prepareRunnerGitWorkspace(payload, {
      cwd: options.cwd,
    });
    logger.info({ phase: "git.workspace.prepare", status: "finish" }, "git.workspace.prepare finish");
    // PIPE-94.6/94.8: resolve the durable substrate (db.url-gated) up front so a
    // resume re-submission can short-circuit nodes already recorded PASSED before
    // doing any expensive work (creds, config, schedule compile, dependency merge,
    // setup, task run). The persisted result is the source of truth; resolution
    // never fails the runner (it returns `undefined` when no substrate exists).
    const persistence = yield* resolveRunnerPersistenceEffect(
      Option.fromNullishOr(options.resolvePersistence),
      { runId: payload.run.id, worktreePath },
      logger,
    );
    const skipped = yield* skipAlreadyPassedNodeEffect({
      descriptorNodeId: descriptor.nodeId,
      forceRerunNodeIds: options.forceRerunNodeIds ?? [],
      logger,
      payload,
      persistence,
      sink,
    });
    if (skipped) {
      return EXIT_PASS;
    }
    yield* prepareOpencodeCredentialsPhase(logger);
    logger.info({ phase: "config.load", status: "start" }, "config.load start");
    const baseConfig = yield* attemptSync(() =>
      loadPipelineConfig(worktreePath, {
        allowMissingLintFileReferences: true,
      }),
    );
    logger.info({ phase: "config.load", status: "finish" }, "config.load finish");
    logger.info({ phase: "schedule.compile", status: "start" }, "schedule.compile start");
    const scheduleRaw = yield* runnerScheduleYamlEffect({
      options,
      payload,
      persistence,
    });
    const compiled = yield* attemptSync(() =>
      compileScheduleArtifact(
        baseConfig,
        parseScheduleArtifact(scheduleRaw, scheduleSourceLabel(options)),
        worktreePath,
      ),
    );
    logger.info(
      {
        phase: "schedule.compile",
        status: "finish",
        workflowId: compiled.workflowId,
      },
      "schedule.compile finish",
    );
    const node = yield* resolveRunnerTargetNode(payload, compiled, descriptor);
    // Container nodes (parallel/group) push no output branch of their own, so a
    // dependency on one must resolve to its executable leaf descendants — the
    // nodes that actually wrote `nodes/<id>` refs. Same resolver the Argo DAG
    // compiler uses, so ordering and ref-materialization never diverge.
    const dependencyNodeIds = resolveExecutableDependencyIds(
      indexPlannedNodesById(compiled.plan.topologicalOrder),
      node.needs,
    );
    logger.info(
      {
        dependencyCount: dependencyNodeIds.length,
        nodeId: descriptor.nodeId,
        phase: "dependency.merge",
        status: "start",
      },
      "dependency.merge start",
    );
    yield* io.mergeDependencyRefs({
      committer: compiled.config.runner_command.git.committer,
      dependencyNodeIds,
      payload,
      worktreePath,
    });
    logger.info(
      {
        dependencyCount: dependencyNodeIds.length,
        nodeId: descriptor.nodeId,
        phase: "dependency.merge",
        status: "finish",
      },
      "dependency.merge finish",
    );
    logger.info(
      {
        commandCount: baseConfig.runner_command.environment.setup.length,
        phase: "setup.commands",
        status: "start",
      },
      "setup.commands start",
    );
    yield* runSetupCommands(baseConfig.runner_command.environment.setup, {
      env: options.env ?? process.env,
      logger,
      worktreePath,
    });
    logger.info(
      {
        commandCount: baseConfig.runner_command.environment.setup.length,
        phase: "setup.commands",
        status: "finish",
      },
      "setup.commands finish",
    );
    // PIPE-94.6: the durable substrate (resolved above) persists this node's
    // result alongside the git node-ref + event stream. The run-control
    // node-status writes ride the SAME projection the local run uses
    // (createRunStoreRuntimeReporter wrapping the event-sink reporter), so the
    // external console stream is unchanged and status is recorded identically.
    const recordToSink = (event: PipelineRuntimeEvent): void => {
      sink.recordRuntimeEvent(event);
    };
    const runStoreReporter = Option.map(persistence, (stores) =>
      createRunStoreRuntimeReporter({
        reporter: recordToSink,
        runId: payload.run.id,
        store: stores.runControlStore,
        workspaceRoot: worktreePath,
      }),
    );
    sink.recordRunnerCommandPhase("task.start", `Starting ${descriptor.nodeId}`, {
      kind: node.kind,
      taskId: descriptor.nodeId,
      workflowId: payload.workflow.id,
    });
    logger.info(
      {
        kind: node.kind,
        nodeId: descriptor.nodeId,
        phase: "task.run",
        status: "start",
      },
      "task.run start",
    );
    const taskText = yield* runnerTaskTextEffect(payload.task, worktreePath);
    const result = yield* io.runScheduledWorkflowTask({
      config: compiled.config,
      hookPolicy: payload.hookPolicy,
      nodeId: descriptor.nodeId,
      reporter: Option.match(runStoreReporter, {
        onNone: () => recordToSink,
        onSome: (reporter) => reporter.reporter,
      }),
      runId: payload.run.id,
      task: taskText,
      workflowId: compiled.workflowId,
      worktreePath,
    });
    logger.info(
      {
        exitCode: result.exitCode,
        nodeId: descriptor.nodeId,
        phase: "task.run",
        resultStatus: result.status,
        status: "finish",
      },
      "task.run finish",
    );
    logFailedTaskRun(logger, descriptor.nodeId, result);
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "git.node-ref.push",
        status: "start",
      },
      "git.node-ref.push start",
    );
    yield* io.commitAndPushNodeRef({
      committer: compiled.config.runner_command.git.committer,
      nodeId: descriptor.nodeId,
      payload,
      worktreePath,
    });
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "git.node-ref.push",
        status: "finish",
      },
      "git.node-ref.push finish",
    );
    sink.recordRunnerCommandPhase("task.finish", `Finished ${descriptor.nodeId}`, {
      evidence: result.evidence,
      exitCode: result.exitCode,
      output: result.output,
      taskId: descriptor.nodeId,
      workflowId: payload.workflow.id,
    });
    yield* flushAndReport(sink, logger);
    // PIPE-94.6: the durable substrate is the source of truth for status/results
    // and is ADDITIVE — a store failure is logged and never changes the exit code
    // (the node's real pass/fail still governs Argo's retry/handling).
    yield* persistNodeResultEffect(
      persistence,
      runStoreReporter,
      { nodeId: descriptor.nodeId, result, runId: payload.run.id },
      logger,
    );
    return nodeProcessExitCode(result);
  }).pipe(Effect.catch((error) => Effect.sync(() => runnerCommandErrorExitCode(error, runtime.logger))));

const createRunnerLogger = (options: { stderr: OutputStream; stdout: OutputStream }): pino.Logger => {
  const streams: pino.StreamEntry[] = [
    { level: "info", stream: options.stdout },
    { level: "error", stream: options.stderr },
  ];
  return pino(
    {
      base: undefined,
      level: "info",
      name: "moka-runner",
      redact: {
        censor: "[redacted]",
        paths: ["authToken", "*.authToken", "token", "*.token", "password", "*.password", "identity", "*.identity"],
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams, { dedupe: true }),
  );
};

export const runRunnerCommand = async (rawOptions: Partial<RunnerCommandOptions> = {}): Promise<number> => {
  const parsedOptions = parseResultWithSchema(runnerCommandOptionsSchema, rawOptions, { onExcessProperty: "error" });
  const stderr = isOutputStream(rawOptions.stderr) ? rawOptions.stderr : process.stderr;
  const stdout = isOutputStream(rawOptions.stdout) ? rawOptions.stdout : process.stdout;
  const logger = createRunnerLogger({ stderr, stdout });
  if (!parsedOptions.ok) {
    logger.error({ error: parsedOptions.error.message, phase: "options.validate" }, "runner options validation failed");
    return EXIT_VALIDATION;
  }
  const options = parsedOptions.value;
  return await Effect.runPromise(
    Effect.provide(
      Effect.scoped(runRunnerCommandEffect(options, { logger, stderr, stdout })),
      RunnerCommandIoServiceLive,
    ),
  );
};
