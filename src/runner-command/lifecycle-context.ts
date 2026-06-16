import { join } from "node:path";
import { Effect } from "effect";
import {
  loadPipelineConfig,
  PIPELINE_CONFIG_PATH,
  PROFILES_CONFIG_PATH,
  parsePipelineConfigParts,
  RUNNERS_CONFIG_PATH,
} from "../config";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import { parseRunnerCommandPayload } from "../runner-command-contract";
import type { createRunnerEventSink } from "../runner-event-sink";
import type { RuntimeContext } from "../runtime/contracts";
import { initialNodeStateStore } from "../runtime/node-state-store";
import {
  createRunnerCommandEventSink,
  RunnerCommandIoService,
} from "../runtime/services/runner-command-io-service";
import { runnerTaskTextEffect } from "./run";

interface RunnerLifecycleContextOptions {
  cwd?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  payloadFile: string;
  scheduleFile: string;
}

export function createRunnerLifecycleContextEffect(
  options: RunnerLifecycleContextOptions
): Effect.Effect<RunnerLifecycleContext, unknown, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const payload = yield* readRunnerPayloadEffect(options.payloadFile);
    const sink = createRunnerCommandEventSink({
      fetch: options.fetch,
      payload,
    });
    const worktreePath = yield* prepareRunnerWorktreeEffect(
      payload,
      options.cwd
    );
    const config = yield* loadRunnerLifecycleConfigEffect(worktreePath);
    const compiled = yield* compileRunnerScheduleEffect(
      config,
      options.scheduleFile,
      worktreePath
    );
    yield* assertWorkflowIdsMatch(payload.workflow.id, compiled.workflowId);
    const task = yield* runnerTaskTextEffect(payload.task, worktreePath);
    const context = buildRunnerRuntimeContext({
      compiled,
      payload,
      sink,
      task,
      worktreePath,
    });

    return { compiled, context, payload, sink, worktreePath };
  });
}

function readRunnerPayloadEffect(
  payloadFile: string
): Effect.Effect<
  ReturnType<typeof parseRunnerCommandPayload>,
  unknown,
  RunnerCommandIoService
> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    const payloadRaw = yield* io.readText(payloadFile);
    return yield* attemptSync(() => parseRunnerCommandPayload(payloadRaw));
  });
}

function prepareRunnerWorktreeEffect(
  payload: ReturnType<typeof parseRunnerCommandPayload>,
  cwd: string | undefined
): Effect.Effect<string, unknown, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    return yield* io.prepareRunnerGitWorkspace(payload, { cwd });
  });
}

function compileRunnerScheduleEffect(
  config: ReturnType<typeof loadPipelineConfig>,
  scheduleFile: string,
  worktreePath: string
): Effect.Effect<
  ReturnType<typeof compileScheduleArtifact>,
  unknown,
  RunnerCommandIoService
> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    const scheduleRaw = yield* io.readText(scheduleFile);
    return yield* attemptSync(() =>
      compileScheduleArtifact(
        config,
        parseScheduleArtifact(scheduleRaw, scheduleFile),
        worktreePath
      )
    );
  });
}

function assertWorkflowIdsMatch(
  payloadWorkflowId: string,
  scheduleWorkflowId: string
): Effect.Effect<void, Error> {
  if (payloadWorkflowId === scheduleWorkflowId) {
    return Effect.void;
  }
  return Effect.fail(
    new Error(
      `Runner payload workflow '${payloadWorkflowId}' does not match schedule workflow '${scheduleWorkflowId}'`
    )
  );
}

function buildRunnerRuntimeContext(options: {
  compiled: ReturnType<typeof compileScheduleArtifact>;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  sink: ReturnType<typeof createRunnerEventSink>;
  task: string;
  worktreePath: string;
}): RuntimeContext {
  return {
    agentInvocations: [],
    config: options.compiled.config,
    executor: () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: runnerHookPolicy(options.payload),
    hookResults: new Map(),
    nodeStateStore: initialNodeStateStore(options.compiled.plan),
    plan: options.compiled.plan,
    reporter: (event) => options.sink.recordRuntimeEvent(event),
    runId: options.payload.run.id,
    task: options.task,
    workflowId: options.compiled.workflowId,
    worktreePath: options.worktreePath,
  };
}

function runnerHookPolicy(
  payload: ReturnType<typeof parseRunnerCommandPayload>
) {
  const {
    allowCommandHooks = true,
    allowUntrustedCommandHooks = true,
    env = {},
    envPassthrough = ["PATH"],
    outputLimitBytes = 64 * 1024,
    timeoutMs = 30_000,
  } = payload.hookPolicy ?? {};
  return {
    allowCommandHooks,
    allowUntrustedCommandHooks,
    env,
    envPassthrough,
    outputLimitBytes,
    timeoutMs,
  };
}

function loadRunnerLifecycleConfigEffect(
  worktreePath: string
): Effect.Effect<
  ReturnType<typeof loadPipelineConfig>,
  unknown,
  RunnerCommandIoService
> {
  return Effect.gen(function* () {
    const pipelinePath = join(worktreePath, PIPELINE_CONFIG_PATH);
    const profilesPath = join(worktreePath, PROFILES_CONFIG_PATH);
    const runnersPath = join(worktreePath, RUNNERS_CONFIG_PATH);
    const hasConfigParts = yield* hasRunnerLifecycleConfigParts([
      pipelinePath,
      profilesPath,
      runnersPath,
    ]);
    if (hasConfigParts) {
      const parts = yield* readRunnerLifecycleConfigParts({
        pipelinePath,
        profilesPath,
        runnersPath,
      });
      return yield* attemptSync(() =>
        parsePipelineConfigParts(
          {
            pipeline: parts.pipeline,
            profiles: parts.profiles,
            runners: parts.runners,
          },
          worktreePath,
          {
            pipeline: PIPELINE_CONFIG_PATH,
            profiles: PROFILES_CONFIG_PATH,
            runners: RUNNERS_CONFIG_PATH,
          },
          { allowMissingLintFileReferences: true }
        )
      );
    }
    return yield* attemptSync(() =>
      loadPipelineConfig(worktreePath, {
        allowMissingLintFileReferences: true,
      })
    );
  });
}

function hasRunnerLifecycleConfigParts(
  paths: string[]
): Effect.Effect<boolean, unknown, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    for (const path of paths) {
      const exists = yield* io.exists(path);
      if (!exists) {
        return false;
      }
    }
    return true;
  });
}

function readRunnerLifecycleConfigParts(paths: {
  pipelinePath: string;
  profilesPath: string;
  runnersPath: string;
}): Effect.Effect<
  { pipeline: string; profiles: string; runners: string },
  unknown,
  RunnerCommandIoService
> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    return {
      pipeline: yield* io.readText(paths.pipelinePath),
      profiles: yield* io.readText(paths.profilesPath),
      runners: yield* io.readText(paths.runnersPath),
    };
  });
}

function attemptSync<T>(try_: () => T): Effect.Effect<T, unknown> {
  return Effect.try({ try: try_, catch: (error) => error });
}

export interface RunnerLifecycleContext {
  compiled: ReturnType<typeof compileScheduleArtifact>;
  context: RuntimeContext;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  sink: ReturnType<typeof createRunnerEventSink>;
  worktreePath: string;
}
