import { resolve } from "node:path";
import { Effect } from "effect";
import pino from "pino";
import { z } from "zod";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import { findPlannedNode } from "../planned-node";
import {
  indexPlannedNodesById,
  resolveExecutableDependencyIds,
} from "../planning/dependency-refs";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import {
  parseRunnerCommandPayload,
  RunnerCommandPayloadValidationError,
  type RunnerTask,
  resolveRunnerEventSinkAuthToken,
} from "../runner-command-contract";
import { createRunnerEventSink } from "../runner-event-sink";
import type { RuntimeNodeResult } from "../runtime/contracts";
import {
  RunnerCommandIoService,
  RunnerCommandIoServiceLive,
} from "../runtime/services/runner-command-io-service";
import {
  DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH,
  readRunnerTaskDescriptorEffect,
} from "./task-descriptor";

interface OutputStream {
  write(chunk: string | Uint8Array): void;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const runnerCommandOptionsSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    fetch: z
      .custom<FetchLike>((value) => typeof value === "function")
      .optional(),
    payloadFile: z.string().min(1),
    scheduleFile: z.string().min(1),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    stdout: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    taskDescriptorFile: z.string().min(1).optional(),
  })
  .strict();

export type RunnerCommandOptions = z.input<typeof runnerCommandOptionsSchema>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

export function runRunnerCommand(
  rawOptions: Partial<RunnerCommandOptions> = {}
): Promise<number> {
  const parsedOptions = runnerCommandOptionsSchema.safeParse(rawOptions);
  const stderr = isOutputStream(rawOptions.stderr)
    ? rawOptions.stderr
    : process.stderr;
  const stdout = isOutputStream(rawOptions.stdout)
    ? rawOptions.stdout
    : process.stdout;
  const logger = createRunnerLogger({ stderr, stdout });
  if (!parsedOptions.success) {
    logger.error(
      { error: parsedOptions.error.message, phase: "options.validate" },
      "runner options validation failed"
    );
    return Promise.resolve(EXIT_VALIDATION);
  }
  const options = parsedOptions.data;
  return Effect.runPromise(
    Effect.provide(
      runRunnerCommandEffect(options, { logger, stderr, stdout }),
      RunnerCommandIoServiceLive
    )
  );
}

// Resolve the planned node this Argo task targets, failing with the runner's
// validation messages when the payload workflow disagrees with the schedule or
// the task isn't in the plan. Extracted so runRunnerCommandEffect stays within
// the complexity budget.
function resolveRunnerTargetNode(
  payload: ReturnType<typeof parseRunnerCommandPayload>,
  compiled: ReturnType<typeof compileScheduleArtifact>,
  descriptor: { nodeId: string }
): Effect.Effect<NonNullable<ReturnType<typeof findPlannedNode>>, unknown> {
  return Effect.gen(function* () {
    if (payload.workflow.id !== compiled.workflowId) {
      return yield* Effect.fail(
        new Error(
          `Runner payload workflow '${payload.workflow.id}' does not match schedule workflow '${compiled.workflowId}'`
        )
      );
    }
    const node = findPlannedNode(
      compiled.plan.topologicalOrder,
      descriptor.nodeId
    );
    if (!node) {
      return yield* Effect.fail(
        new Error(
          `Argo task '${descriptor.nodeId}' is not declared in workflow '${compiled.workflowId}'`
        )
      );
    }
    return node;
  });
}

function runRunnerCommandEffect(
  options: RunnerCommandOptions,
  runtime: { logger: pino.Logger; stderr: OutputStream; stdout: OutputStream }
): Effect.Effect<number, never, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    const logger = runtime.logger;
    logger.info(
      { phase: "payload.load", status: "start" },
      "payload.load start"
    );
    const payloadRaw = yield* io.readText(options.payloadFile);
    const payload = yield* attemptSync(() =>
      parseRunnerCommandPayload(payloadRaw)
    );
    const descriptor = yield* readRunnerTaskDescriptorEffect(
      options.taskDescriptorFile ?? DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH
    );
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "payload.load",
        runId: payload.run.id,
        status: "finish",
        workflowId: payload.workflow.id,
      },
      "payload.load finish"
    );
    logger.info(
      { phase: "event.sink.configure", status: "start" },
      "event.sink.configure start"
    );
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
    logger.info(
      { phase: "event.sink.configure", status: "finish" },
      "event.sink.configure finish"
    );
    logger.info(
      {
        hasProvidedCwd: Boolean(options.cwd),
        phase: "git.workspace.prepare",
        status: "start",
      },
      "git.workspace.prepare start"
    );
    const worktreePath = yield* io.prepareRunnerGitWorkspace(payload, {
      cwd: options.cwd,
    });
    logger.info(
      { phase: "git.workspace.prepare", status: "finish" },
      "git.workspace.prepare finish"
    );
    logger.info(
      { phase: "opencode.credentials.prepare", status: "start" },
      "opencode.credentials.prepare start"
    );
    const credentialsPrep = yield* io.prepareOpencodeCredentials();
    logger.info(
      {
        copied: credentialsPrep.copied,
        hostOpenaiTokenSynced: credentialsPrep.hostOpenaiTokenSynced,
        phase: "opencode.credentials.prepare",
        status: "finish",
      },
      "opencode.credentials.prepare finish"
    );
    logger.info({ phase: "config.load", status: "start" }, "config.load start");
    const baseConfig = yield* attemptSync(() =>
      loadPipelineConfig(worktreePath, {
        allowMissingLintFileReferences: true,
      })
    );
    logger.info(
      { phase: "config.load", status: "finish" },
      "config.load finish"
    );
    logger.info(
      { phase: "schedule.compile", status: "start" },
      "schedule.compile start"
    );
    const scheduleRaw = yield* io.readText(options.scheduleFile);
    const compiled = yield* attemptSync(() =>
      compileScheduleArtifact(
        baseConfig,
        parseScheduleArtifact(scheduleRaw, options.scheduleFile),
        worktreePath
      )
    );
    logger.info(
      {
        phase: "schedule.compile",
        status: "finish",
        workflowId: compiled.workflowId,
      },
      "schedule.compile finish"
    );
    const node = yield* resolveRunnerTargetNode(payload, compiled, descriptor);
    // Container nodes (parallel/group) push no output branch of their own, so a
    // dependency on one must resolve to its executable leaf descendants — the
    // nodes that actually wrote `nodes/<id>` refs. Same resolver the Argo DAG
    // compiler uses, so ordering and ref-materialization never diverge.
    const dependencyNodeIds = resolveExecutableDependencyIds(
      indexPlannedNodesById(compiled.plan.topologicalOrder),
      node.needs
    );
    logger.info(
      {
        dependencyCount: dependencyNodeIds.length,
        nodeId: descriptor.nodeId,
        phase: "dependency.merge",
        status: "start",
      },
      "dependency.merge start"
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
      "dependency.merge finish"
    );
    logger.info(
      {
        commandCount: baseConfig.runner_command.environment.setup.length,
        phase: "setup.commands",
        status: "start",
      },
      "setup.commands start"
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
      "setup.commands finish"
    );
    sink.recordRunnerCommandPhase(
      "task.start",
      `Starting ${descriptor.nodeId}`,
      {
        kind: node.kind,
        taskId: descriptor.nodeId,
        workflowId: payload.workflow.id,
      }
    );
    logger.info(
      {
        kind: node.kind,
        nodeId: descriptor.nodeId,
        phase: "task.run",
        status: "start",
      },
      "task.run start"
    );
    const taskText = yield* runnerTaskTextEffect(payload.task, worktreePath);
    const result = yield* io.runScheduledWorkflowTask({
      config: compiled.config,
      hookPolicy: payload.hookPolicy,
      nodeId: descriptor.nodeId,
      reporter: (event) => sink.recordRuntimeEvent(event),
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
      "task.run finish"
    );
    logFailedTaskRun(logger, descriptor.nodeId, result);
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "git.node-ref.push",
        status: "start",
      },
      "git.node-ref.push start"
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
      "git.node-ref.push finish"
    );
    sink.recordRunnerCommandPhase(
      "task.finish",
      `Finished ${descriptor.nodeId}`,
      {
        evidence: result.evidence,
        exitCode: result.exitCode,
        output: result.output,
        taskId: descriptor.nodeId,
        workflowId: payload.workflow.id,
      }
    );
    yield* flushAndReport(sink, logger);
    return result.status === "passed" ? EXIT_PASS : EXIT_FAIL;
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => runnerCommandErrorExitCode(error, runtime.logger))
    )
  );
}

function attemptSync<T>(try_: () => T): Effect.Effect<T, unknown> {
  return Effect.try({ try: try_, catch: (error) => error });
}

function runnerCommandErrorExitCode(error: unknown, logger: pino.Logger) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ error: message, phase: "runner-command" }, message);
  return error instanceof RunnerCommandPayloadValidationError ||
    error instanceof z.ZodError
    ? EXIT_VALIDATION
    : EXIT_STARTUP;
}

function runSetupCommands(
  commands: PipelineConfig["runner_command"]["environment"]["setup"],
  options: {
    env: Record<string, string | undefined>;
    logger: pino.Logger;
    worktreePath: string;
  }
): Effect.Effect<void, unknown, RunnerCommandIoService> {
  return Effect.forEach(commands.entries(), ([index, command]) =>
    runSetupCommand(command, index, options)
  ).pipe(Effect.asVoid);
}

function runSetupCommand(
  command: PipelineConfig["runner_command"]["environment"]["setup"][number],
  index: number,
  options: {
    env: Record<string, string | undefined>;
    logger: pino.Logger;
    worktreePath: string;
  }
): Effect.Effect<void, unknown, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    const commandIndex = index + 1;
    options.logger.info(
      setupCommandLog(command.command, commandIndex, "start"),
      "setup.command start"
    );
    const result = yield* io.runSetupCommand(command.command, command.args, {
      cwd: options.worktreePath,
      env: options.env,
    });
    const exitCode = setupExitCode(result.exitCode);
    options.logger.info(
      setupCommandFinishLog(command, commandIndex, exitCode),
      "setup.command finish"
    );
    if (exitCode !== 0) {
      // Surface the command's captured output on failure — without it a failing
      // setup command (e.g. a repo bootstrap install) is undebuggable in the pod
      // log, which only showed the exit code.
      options.logger.error(
        setupCommandOutputLog(command.command, commandIndex, result),
        "setup.command output"
      );
    }
    if (exitCode !== 0 && command.required) {
      return yield* Effect.fail(
        new Error(
          `runner setup command '${command.command}' failed with exit ${exitCode}`
        )
      );
    }
  });
}

function setupExitCode(exitCode: number | undefined): number {
  if (typeof exitCode === "number") {
    return exitCode;
  }
  return 1;
}

const SETUP_OUTPUT_TAIL = 4000;

function setupOutputTail(output: unknown): string {
  if (typeof output !== "string" || output.length === 0) {
    return "";
  }
  return output.length > SETUP_OUTPUT_TAIL
    ? output.slice(-SETUP_OUTPUT_TAIL)
    : output;
}

function setupCommandOutputLog(
  command: string,
  index: number,
  result: { stderr?: unknown; stdout?: unknown }
) {
  return {
    command,
    index,
    phase: "setup.command",
    status: "output",
    stderr: setupOutputTail(result.stderr),
    stdout: setupOutputTail(result.stdout),
  };
}

function setupCommandLog(command: string, index: number, status: "start") {
  return { command, index, phase: "setup.command", status };
}

function setupCommandFinishLog(
  command: PipelineConfig["runner_command"]["environment"]["setup"][number],
  index: number,
  exitCode: number
) {
  return {
    command: command.command,
    exitCode,
    index,
    phase: "setup.command",
    required: command.required,
    status: "finish",
  };
}

function logFailedTaskRun(
  logger: pino.Logger,
  nodeId: string,
  result: RuntimeNodeResult
): void {
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
    "task.run failed"
  );
}

export function runnerTaskTextEffect(
  task: RunnerTask,
  worktreePath: string
): Effect.Effect<string, unknown, RunnerCommandIoService> {
  if (task.kind === "prompt") {
    return Effect.succeed(task.prompt);
  }
  if (task.path) {
    const taskPath = task.path;
    return Effect.gen(function* () {
      const io = yield* RunnerCommandIoService;
      return yield* io.readText(resolve(worktreePath, taskPath));
    });
  }
  return Effect.succeed([task.id, task.title].filter(Boolean).join(" "));
}

function isOutputStream(value: unknown): value is OutputStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "write" in value &&
    typeof value.write === "function"
  );
}

function flushAndReport(
  sink: ReturnType<typeof createRunnerEventSink>,
  logger: pino.Logger
): Effect.Effect<void, never, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    logger.info({ phase: "event.flush", status: "start" }, "event.flush start");
    const result = yield* Effect.either(io.flushSink(sink));
    if (result._tag === "Right") {
      logger.info(
        { phase: "event.flush", status: "finish" },
        "event.flush finish"
      );
      return;
    }
    const error = result.left;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { error: message, phase: "event.flush" },
      `runner event flush failed: ${message}`
    );
  });
}

function createRunnerLogger(options: {
  stderr: OutputStream;
  stdout: OutputStream;
}): pino.Logger {
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
        paths: [
          "authToken",
          "*.authToken",
          "token",
          "*.token",
          "password",
          "*.password",
          "identity",
          "*.identity",
        ],
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams, { dedupe: true })
  );
}
