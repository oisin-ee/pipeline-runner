import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PipelineConfig, PipelineConfigError } from "../config.js";
import {
  type PipelineRuntimeEvent,
  type PipelineRuntimeResult,
  runPipelineFromConfig,
} from "../pipeline-runtime.js";
import {
  createRunnerEventSink,
  type RunnerEventSink,
} from "../runner-event-sink.js";
import {
  parseRunnerJobPayloadWithIssues,
  type RecoverableRunnerJobPayloadEnvelope,
  RUNNER_PAYLOAD_ENV,
  type RunnerJobPayload,
  type RunnerJobPayloadValidationError,
  type RunnerTask,
  resolveRunnerEventSinkAuthToken,
} from "../runner-job-contract.js";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
} from "../schedule-planner.js";
import { createPullRequest, type PullRequestCreator } from "./delivery.js";
import {
  assertRunnerDevspaceReady,
  type RunnerDevspaceCommand,
  type RunnerDevspaceReadiness,
  runRunnerDevspaceSmoke,
  runRunnerEnvironmentSetup,
} from "./devspace.js";
import {
  prepareRunnerWorkspace,
  type RunnerWorkspacePreparation,
} from "./workspace.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

type PipelineRunner = typeof runPipelineFromConfig;
type SchedulePreparer = typeof generateRunnerSchedule;
type WorkspacePreparer = typeof prepareRunnerWorkspace;

interface OutputStream {
  write(chunk: string | Uint8Array): boolean;
}

interface SignalEmitter {
  off?: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  on: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  removeListener?: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
}

interface PreparedRunnerJob {
  env: Record<string, string | undefined>;
  payload: RunnerJobPayload;
  stderr: OutputStream;
}

type PrepareRunnerJobResult =
  | { exitCode: number; job?: never }
  | {
      exitCode?: never;
      job?: never;
      validationFailure: PreparedValidationFailure;
    }
  | { exitCode?: never; job: PreparedRunnerJob };

interface PreparedValidationFailure {
  env: Record<string, string | undefined>;
  error: RunnerJobPayloadValidationError;
  recoverable?: RecoverableRunnerJobPayloadEnvelope;
  stderr: OutputStream;
}

export interface RunnerJobOptions {
  createPullRequest?: PullRequestCreator;
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  onForceExit?: (exitCode: number) => void;
  pipelineRunner?: PipelineRunner;
  prepareSchedule?: SchedulePreparer;
  prepareWorkspace?: WorkspacePreparer;
  runDevspaceCommand?: RunnerDevspaceCommand;
  signalEmitter?: SignalEmitter;
  stderr?: OutputStream;
  stdout?: OutputStream;
}

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CANCELLED = 130;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;
const RUNNER_EVENT_SINK_URL_ENV = "OISIN_PIPELINE_EVENT_SINK_URL";
const RUNNER_EVENT_SINK_AUTH_HEADER_ENV = "OISIN_PIPELINE_EVENT_AUTH_HEADER";
const RUNNER_SCHEDULE_ENTRYPOINT = "pipe";

export async function runRunnerJob(
  options: RunnerJobOptions = {}
): Promise<number> {
  const prepared = prepareRunnerJob(options);
  if (prepared.exitCode !== undefined) {
    return prepared.exitCode;
  }
  if ("validationFailure" in prepared) {
    return reportPreparedValidationFailure(prepared.validationFailure, options);
  }
  const { env, payload, stderr } = prepared.job;

  const controller = new AbortController();
  const signalEmitter = options.signalEmitter ?? process;
  const forceExit =
    options.onForceExit ?? ((exitCode: number) => process.exit(exitCode));
  let signalExitCode: number | undefined;
  let signalCount = 0;
  let signalFinalResultRecorded = false;

  const sink = createRunnerSink({
    env,
    fetch: options.fetch,
    runId: payload.run.id,
  });

  const handleSignal = (exitCode: number): void => {
    signalCount += 1;
    if (signalCount === 1) {
      signalExitCode = exitCode;
      sink.recordCancellation(RUNNER_SCHEDULE_ENTRYPOINT);
      signalFinalResultRecorded = true;
      controller.abort();
      return;
    }
    forceExit(signalExitCode ?? exitCode);
  };
  const handleSigterm = (): void => handleSignal(EXIT_CANCELLED);
  const handleSigint = (): void => handleSignal(EXIT_CANCELLED);
  signalEmitter.on("SIGTERM", handleSigterm);
  signalEmitter.on("SIGINT", handleSigint);

  const runner = options.pipelineRunner ?? runPipelineFromConfig;
  let sawWorkflowFinish = false;

  try {
    const { config, readiness, task, workflowId, workspace } =
      await prepareReadyWorkspace(options, payload, env, sink);
    const result = await runner({
      config,
      reporter: (event: PipelineRuntimeEvent) => {
        if (event.type === "workflow.finish") {
          sawWorkflowFinish = true;
        }
        sink.recordRuntimeEvent(event);
      },
      runId: payload.run.id,
      signal: controller.signal,
      task,
      hookPolicy: {
        allowCommandHooks: true,
      },
      workflowId,
      worktreePath: workspace.worktreePath,
    });

    if (result.outcome === "PASS") {
      await deliverSuccessfulRun(options, payload, workspace, readiness, sink);
    }

    if (!(sawWorkflowFinish || signalFinalResultRecorded)) {
      sink.recordFinalResult(result.outcome, result.plan.workflowId);
    }
    const flushFailure = await flushAndReport(sink.flush, stderr);
    if (flushFailure && !signalExitCode) {
      return EXIT_STARTUP;
    }
    return signalExitCode ?? exitCodeForRuntimeResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    await flushAndReport(sink.flush, stderr);
    if (err instanceof PipelineConfigError) {
      return signalExitCode ?? EXIT_VALIDATION;
    }
    return signalExitCode ?? EXIT_STARTUP;
  } finally {
    removeSignalListener(signalEmitter, "SIGTERM", handleSigterm);
    removeSignalListener(signalEmitter, "SIGINT", handleSigint);
  }
}

async function prepareReadyWorkspace(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  env: Record<string, string | undefined>,
  sink: RunnerEventSink
): Promise<{
  config: PipelineConfig;
  readiness: RunnerDevspaceReadiness;
  task: string;
  workflowId: string;
  workspace: RunnerWorkspacePreparation;
}> {
  const workspace = await prepareWorkspace(options, payload, env);
  sink.recordRunnerJobPhase("workspace.prepared", "runner workspace prepared", {
    worktreePath: workspace.worktreePath,
  });
  const readiness = assertRunnerDevspaceReady(workspace.worktreePath);
  const config = requireRunnerConfig(readiness);
  sink.recordRunnerJobPhase("environment.ready", "runner environment ready");
  const setupStatus = await runRunnerEnvironmentSetup({
    config,
    env: workspace.env,
    runCommand: options.runDevspaceCommand,
    worktreePath: workspace.worktreePath,
  });
  sink.recordRunnerJobPhase(
    `environment.setup.${setupStatus}`,
    `runner environment setup ${setupStatus}`
  );
  const task = resolveRunnerTask(payload.task, workspace.worktreePath);
  const prepareSchedule =
    options.prepareSchedule ??
    (options.pipelineRunner
      ? useConfiguredDefaultWorkflow
      : generateRunnerSchedule);
  const compiled = await prepareSchedule(config, task, workspace, sink);
  return {
    config: compiled.config,
    readiness,
    task,
    workflowId: compiled.workflowId,
    workspace,
  };
}

function requireRunnerConfig(
  readiness: RunnerDevspaceReadiness
): PipelineConfig {
  if (!readiness.config) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_VALIDATION_ERROR",
      "Runner jobs require a repository pipeline config",
      [
        {
          message: ".pipeline/pipeline.yaml is required for runner jobs",
          path: ".pipeline/pipeline.yaml",
        },
      ]
    );
  }
  return readiness.config;
}

function resolveRunnerTask(task: RunnerTask, worktreePath: string): string {
  if (task.kind === "prompt") {
    return task.prompt;
  }
  if (task.path) {
    return readFileSync(join(worktreePath, task.path), "utf8");
  }
  return task.id;
}

function useConfiguredDefaultWorkflow(
  config: PipelineConfig
): Promise<{ config: PipelineConfig; workflowId: string }> {
  return Promise.resolve({ config, workflowId: config.default_workflow });
}

async function generateRunnerSchedule(
  config: PipelineConfig,
  task: string,
  workspace: RunnerWorkspacePreparation,
  sink: RunnerEventSink
): Promise<{ config: PipelineConfig; workflowId: string }> {
  const result = await generateScheduleArtifact({
    config,
    entrypointId: RUNNER_SCHEDULE_ENTRYPOINT,
    task,
    worktreePath: workspace.worktreePath,
  });
  sink.recordRunnerJobPhase("schedule.generated", "runner schedule generated", {
    path: result.path,
  });
  const compiled = compileScheduleArtifact(
    config,
    result.artifact,
    workspace.worktreePath
  );
  return { config: compiled.config, workflowId: compiled.workflowId };
}

async function deliverSuccessfulRun(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  workspace: RunnerWorkspacePreparation,
  readiness: RunnerDevspaceReadiness,
  sink: RunnerEventSink
): Promise<void> {
  if (readiness.config) {
    const config = readiness.config;
    const smokeStatus = await runRunnerDevspaceSmokeWithPhase(
      options,
      config,
      workspace,
      sink
    );
    sink.recordRunnerJobPhase(
      `environment.smoke.${smokeStatus}`,
      `runner environment smoke ${smokeStatus}`
    );
  }
  const pullRequest = await createRunnerPullRequestWithPhase(
    options,
    payload,
    workspace,
    sink
  );
  if (pullRequest) {
    sink.recordRunnerJobPhase(
      "delivery.pull_request",
      "runner pull request created",
      { url: pullRequest.url }
    );
  }
}

async function runRunnerDevspaceSmokeWithPhase(
  options: RunnerJobOptions,
  config: PipelineConfig,
  workspace: RunnerWorkspacePreparation,
  sink: RunnerEventSink
): Promise<"ran" | "skipped"> {
  try {
    return await runRunnerDevspaceSmoke({
      config,
      env: workspace.env,
      runCommand: options.runDevspaceCommand,
      worktreePath: workspace.worktreePath,
    });
  } catch (err) {
    sink.recordRunnerJobPhase(
      "environment.smoke.failed",
      "runner environment smoke failed",
      { error: errorMessage(err) }
    );
    throw err;
  }
}

async function createRunnerPullRequestWithPhase(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  workspace: RunnerWorkspacePreparation,
  sink: RunnerEventSink
) {
  try {
    return await createRunnerPullRequest(
      options,
      payload,
      workspace.worktreePath,
      workspace.env
    );
  } catch (err) {
    sink.recordRunnerJobPhase(
      "delivery.pull_request.failed",
      "runner pull request creation failed",
      { error: errorMessage(err) }
    );
    throw err;
  }
}

function createRunnerPullRequest(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  worktreePath: string,
  env: Record<string, string | undefined>
) {
  const create = options.createPullRequest ?? createPullRequest;
  return create({
    env,
    payload,
    worktreePath,
  });
}

function prepareWorkspace(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  env: Record<string, string | undefined>
): Promise<RunnerWorkspacePreparation> {
  const prepare = options.prepareWorkspace ?? prepareRunnerWorkspace;
  return prepare({
    cwd: options.cwd,
    env,
    payload,
  });
}

function prepareRunnerJob(options: RunnerJobOptions): PrepareRunnerJobResult {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const payloadRaw = env[RUNNER_PAYLOAD_ENV];
  if (!payloadRaw) {
    stderr.write(`${RUNNER_PAYLOAD_ENV} is required\n`);
    return { exitCode: EXIT_VALIDATION };
  }

  const payload = parsePayload(payloadRaw, stderr);
  if (!payload.ok) {
    return {
      validationFailure: {
        env,
        error: payload.error,
        recoverable: payload.recoverable,
        stderr,
      },
    };
  }

  return { job: { env, payload: payload.payload, stderr } };
}

function parsePayload(
  payloadRaw: string,
  stderr: OutputStream
): ReturnType<typeof parseRunnerJobPayloadWithIssues> {
  const result = parseRunnerJobPayloadWithIssues(payloadRaw);
  if (!result.ok) {
    stderr.write(`${result.error.message}\n`);
  }
  return result;
}

async function reportPreparedValidationFailure(
  failure: PreparedValidationFailure,
  options: RunnerJobOptions
): Promise<number> {
  if (failure.recoverable) {
    const sink = createRunnerSink({
      env: failure.env,
      fetch: options.fetch,
      runId: failure.recoverable.run.id,
    });
    sink.recordSchemaValidationFailure(
      failure.error.message,
      failure.error.issues,
      RUNNER_SCHEDULE_ENTRYPOINT
    );
    await flushAndReport(sink.flush, failure.stderr);
  }
  return EXIT_VALIDATION;
}

function resolveAuthToken(
  env: Record<string, string | undefined>,
  stderr: OutputStream
): string | null {
  try {
    return resolveRunnerEventSinkAuthToken({ env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    return null;
  }
}

function createRunnerSink(options: {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  runId: string;
}): RunnerEventSink {
  const url = options.env[RUNNER_EVENT_SINK_URL_ENV]?.trim();
  if (!url) {
    return createNoopRunnerEventSink();
  }
  const authToken = resolveAuthToken(options.env, { write: () => true });
  if (!authToken) {
    return createNoopRunnerEventSink();
  }
  return createRunnerEventSink({
    authHeader:
      options.env[RUNNER_EVENT_SINK_AUTH_HEADER_ENV]?.trim() || "Authorization",
    authToken,
    fetch: options.fetch,
    runId: options.runId,
    url,
  });
}

function createNoopRunnerEventSink(): RunnerEventSink {
  return {
    fail: () => Promise.resolve(),
    flush: () => Promise.resolve(),
    recordCancellation: () => undefined,
    recordFinalResult: () => undefined,
    recordRunnerJobPhase: () => undefined,
    recordRuntimeEvent: () => undefined,
    recordSchemaValidationFailure: () => undefined,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function exitCodeForRuntimeResult(result: PipelineRuntimeResult): number {
  switch (result.outcome) {
    case "PASS":
      return EXIT_PASS;
    case "FAIL":
      return EXIT_FAIL;
    case "CANCELLED":
      return EXIT_CANCELLED;
    default:
      return EXIT_STARTUP;
  }
}

async function flushAndReport(
  flush: () => Promise<void>,
  stderr: OutputStream
): Promise<boolean> {
  try {
    await flush();
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Event sink flush failed: ${message}\n`);
    return true;
  }
}

function removeSignalListener(
  emitter: SignalEmitter,
  event: "SIGINT" | "SIGTERM",
  listener: () => void
): void {
  if (emitter.off) {
    emitter.off(event, listener);
    return;
  }
  emitter.removeListener?.(event, listener);
}
