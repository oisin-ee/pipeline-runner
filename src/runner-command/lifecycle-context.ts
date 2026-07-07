import { join } from "node:path";

import { Effect, Option } from "effect";

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
import { readPersistedScheduleEffect } from "../run-control/next-node";
import { withRunControlStoreScoped } from "../run-control/run-control-store";
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
  scheduleFile?: string;
  scheduleSource?: "db" | "file";
}

const prepareRunnerWorktreeEffect = (
  payload: ReturnType<typeof parseRunnerCommandPayload>,
  cwd: Option.Option<string>
): Effect.Effect<string, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    return yield* io.prepareRunnerGitWorkspace(payload, {
      cwd: Option.getOrUndefined(cwd),
    });
  });

interface CompiledRunnerSchedule {
  compiled: ReturnType<typeof compileScheduleArtifact>;
  scheduleYaml: string;
}

const lifecycleScheduleYamlEffect = (input: {
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  scheduleFile?: string;
  scheduleSource: "db" | "file";
  worktreePath: string;
}): Effect.Effect<string, unknown, RunnerCommandIoService> => {
  if (input.scheduleSource === "db") {
    return withRunControlStoreScoped(input.worktreePath, (store) =>
      readPersistedScheduleEffect(store, input.payload.run.id)
    );
  }
  return Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    return yield* io.readText(input.scheduleFile ?? "");
  });
};

const lifecycleScheduleSourceLabel = (input: {
  scheduleFile?: string;
  scheduleSource: "db" | "file";
}): string =>
  input.scheduleSource === "db"
    ? "persisted schedule"
    : (input.scheduleFile ?? "schedule.yaml");

const assertWorkflowIdsMatch = (
  payloadWorkflowId: string,
  scheduleWorkflowId: string
): Effect.Effect<void, Error> => {
  if (payloadWorkflowId === scheduleWorkflowId) {
    return Effect.void;
  }
  return Effect.fail(
    new Error(
      `Runner payload workflow '${payloadWorkflowId}' does not match schedule workflow '${scheduleWorkflowId}'`
    )
  );
};

const runnerHookPolicy = (
  payload: ReturnType<typeof parseRunnerCommandPayload>
) => {
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
};

const buildRunnerRuntimeContext = (options: {
  compiled: ReturnType<typeof compileScheduleArtifact>;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  sink: ReturnType<typeof createRunnerEventSink>;
  task: string;
  worktreePath: string;
}): RuntimeContext => ({
  agentInvocations: [],
  config: options.compiled.config,
  executor: () => ({ exitCode: 0, stdout: "" }),
  gates: [],
  hookFailures: [],
  hookPolicy: runnerHookPolicy(options.payload),
  hookResults: new Map(),
  nodeStateStore: initialNodeStateStore(options.compiled.plan),
  plan: options.compiled.plan,
  reporter: (event) => {
    options.sink.recordRuntimeEvent(event);
  },
  runId: options.payload.run.id,
  task: options.task,
  workflowId: options.compiled.workflowId,
  worktreePath: options.worktreePath,
});

const hasRunnerLifecycleConfigParts = (
  paths: string[]
): Effect.Effect<boolean, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    for (const path of paths) {
      const exists = yield* io.exists(path);
      if (!exists) {
        return false;
      }
    }
    return true;
  });

const readRunnerLifecycleConfigParts = (paths: {
  pipelinePath: string;
  profilesPath: string;
  runnersPath: string;
}): Effect.Effect<
  { pipeline: string; profiles: string; runners: string },
  unknown,
  RunnerCommandIoService
> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    return {
      pipeline: yield* io.readText(paths.pipelinePath),
      profiles: yield* io.readText(paths.profilesPath),
      runners: yield* io.readText(paths.runnersPath),
    };
  });

const attemptSync = <T>(try_: () => T): Effect.Effect<T, unknown> =>
  Effect.try({ catch: (error) => error, try: try_ });

const readRunnerPayloadEffect = (
  payloadFile: string
): Effect.Effect<
  ReturnType<typeof parseRunnerCommandPayload>,
  unknown,
  RunnerCommandIoService
> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    const payloadRaw = yield* io.readText(payloadFile);
    return yield* attemptSync(() => parseRunnerCommandPayload(payloadRaw));
  });

const compileRunnerScheduleEffect = (input: {
  config: ReturnType<typeof loadPipelineConfig>;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  scheduleFile?: string;
  scheduleSource: "db" | "file";
  worktreePath: string;
}): Effect.Effect<CompiledRunnerSchedule, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const scheduleYaml = yield* lifecycleScheduleYamlEffect(input);
    const compiled = yield* attemptSync(() =>
      compileScheduleArtifact(
        input.config,
        parseScheduleArtifact(
          scheduleYaml,
          lifecycleScheduleSourceLabel(input)
        ),
        input.worktreePath
      )
    );
    return { compiled, scheduleYaml };
  });

const loadRunnerLifecycleConfigEffect = (
  worktreePath: string
): Effect.Effect<
  ReturnType<typeof loadPipelineConfig>,
  unknown,
  RunnerCommandIoService
> =>
  Effect.gen(function* effectBody() {
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

export const createRunnerLifecycleContextEffect = (
  options: RunnerLifecycleContextOptions
): Effect.Effect<RunnerLifecycleContext, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const payload = yield* readRunnerPayloadEffect(options.payloadFile);
    const sink = createRunnerCommandEventSink({
      fetch: options.fetch,
      payload,
    });
    const worktreePath = yield* prepareRunnerWorktreeEffect(
      payload,
      Option.fromNullishOr(options.cwd)
    );
    const config = yield* loadRunnerLifecycleConfigEffect(worktreePath);
    const { compiled, scheduleYaml } = yield* compileRunnerScheduleEffect({
      config,
      payload,
      scheduleFile: options.scheduleFile,
      scheduleSource: options.scheduleSource ?? "file",
      worktreePath,
    });
    yield* assertWorkflowIdsMatch(payload.workflow.id, compiled.workflowId);
    const task = yield* runnerTaskTextEffect(payload.task, worktreePath);
    const context = buildRunnerRuntimeContext({
      compiled,
      payload,
      sink,
      task,
      worktreePath,
    });

    return { compiled, context, payload, scheduleYaml, sink, worktreePath };
  });

export interface RunnerLifecycleContext {
  compiled: ReturnType<typeof compileScheduleArtifact>;
  context: RuntimeContext;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  /** Raw schedule YAML as read from the mounted schedule file. */
  scheduleYaml: string;
  sink: ReturnType<typeof createRunnerEventSink>;
  worktreePath: string;
}
