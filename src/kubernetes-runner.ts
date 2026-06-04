import { PipelineConfigError } from "./config.js";
import {
  type PipelineRuntimeEvent,
  type PipelineRuntimeResult,
  runPipelineFromConfig,
} from "./pipeline-runtime.js";
import { createRunnerEventSink } from "./runner-event-sink.js";
import {
  parseRunnerJobPayloadWithIssues,
  type RecoverableRunnerJobPayloadEnvelope,
  RUNNER_PAYLOAD_ENV,
  type RunnerJobPayload,
  type RunnerJobPayloadValidationError,
  resolveRunnerEventSinkAuthToken,
} from "./runner-job-contract.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

type PipelineRunner = typeof runPipelineFromConfig;

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

export interface KubernetesRunnerJobOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  onForceExit?: (exitCode: number) => void;
  pipelineRunner?: PipelineRunner;
  signalEmitter?: SignalEmitter;
  stderr?: OutputStream;
  stdout?: OutputStream;
}

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_CANCELLED = 130;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

export async function runKubernetesRunnerJob(
  options: KubernetesRunnerJobOptions = {}
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
      worktreePath: env.PIPELINE_TARGET_PATH ?? options.cwd ?? process.cwd(),
    });

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

function prepareRunnerJob(
  options: KubernetesRunnerJobOptions
): PrepareRunnerJobResult {
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
  options: KubernetesRunnerJobOptions
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
