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
  resolveRunnerEventSinkAuthToken,
} from "../runner-job-contract.js";
import { createPullRequest, type PullRequestCreator } from "./delivery.js";
import {
  assertRunnerDevspaceReady,
  type RunnerDevspaceCommand,
  type RunnerDevspaceReadiness,
  runRunnerDevspaceSmoke,
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
  authToken: string;
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
  authToken?: string;
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
  const { authToken, env, payload, stderr } = prepared.job;

  const controller = new AbortController();
  const signalEmitter = options.signalEmitter ?? process;
  const forceExit =
    options.onForceExit ?? ((exitCode: number) => process.exit(exitCode));
  let signalExitCode: number | undefined;
  let signalCount = 0;
  let signalFinalResultRecorded = false;

  const sink = createRunnerEventSink({
    authHeader: payload.eventSink.authHeader,
    authToken,
    fetch: options.fetch,
    runId: payload.run.runId,
    url: payload.eventSink.url,
  });

  const handleSignal = (exitCode: number): void => {
    signalCount += 1;
    if (signalCount === 1) {
      signalExitCode = exitCode;
      sink.recordCancellation(payload.selector.workflowId);
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
    const { readiness, workspace } = await prepareReadyWorkspace(
      options,
      payload,
      env,
      sink
    );
    const result = await runner({
      reporter: (event: PipelineRuntimeEvent) => {
        if (event.type === "workflow.finish") {
          sawWorkflowFinish = true;
        }
        sink.recordRuntimeEvent(event);
      },
      runId: payload.run.runId,
      signal: controller.signal,
      task: payload.task.prompt,
      hookPolicy: {
        allowCommandHooks: payload.selector.allowCommandHooks,
      },
      workflowId: payload.selector.workflowId,
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
  readiness: RunnerDevspaceReadiness;
  workspace: RunnerWorkspacePreparation;
}> {
  const workspace = await prepareWorkspace(options, payload, env);
  sink.recordRunnerJobPhase("workspace.prepared", "runner workspace prepared", {
    worktreePath: workspace.worktreePath,
  });
  const readiness = assertRunnerDevspaceReady(payload, workspace.worktreePath);
  if (readiness.devspaceConfigPath) {
    sink.recordRunnerJobPhase("devspace.ready", "runner devspace ready", {
      path: readiness.devspaceConfigPath,
    });
  }
  return { readiness, workspace };
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
      `devspace.smoke.${smokeStatus}`,
      `runner devspace smoke ${smokeStatus}`
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
      "devspace.smoke.failed",
      "runner devspace smoke failed",
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
    const authToken = resolveAuthToken(env, stderr);
    return {
      validationFailure: {
        authToken: authToken ?? undefined,
        env,
        error: payload.error,
        recoverable: payload.recoverable,
        stderr,
      },
    };
  }

  const authToken = resolveAuthToken(env, stderr);
  if (!authToken) {
    return { exitCode: EXIT_VALIDATION };
  }

  return { job: { authToken, env, payload: payload.payload, stderr } };
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
  if (failure.recoverable && failure.authToken) {
    const sink = createRunnerEventSink({
      authHeader: failure.recoverable.eventSink.authHeader,
      authToken: failure.authToken,
      fetch: options.fetch,
      runId: failure.recoverable.run.runId,
      url: failure.recoverable.eventSink.url,
    });
    sink.recordSchemaValidationFailure(
      failure.error.message,
      failure.error.issues,
      failure.recoverable.workflowId
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
