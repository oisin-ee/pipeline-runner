import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PipelineConfig, PipelineConfigError } from "../config.js";
import {
  type GatewayReconcileResult,
  reconcileGateway as reconcileMcpGateway,
} from "../mcp/gateway.js";
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
  type RunnerJobPayload,
  type RunnerJobPayloadValidationError,
  type RunnerTask,
  resolveRunnerEventSinkAuthToken,
} from "../runner-job-contract.js";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
} from "../schedule-planner.js";
import {
  createPullRequest,
  deliverGitBranch,
  type GitBranchDeliverer,
  type PullRequestCreator,
} from "./delivery.js";
import {
  assertRunnerDevspaceReady,
  type RunnerDevspaceCommand,
  type RunnerDevspaceReadiness,
  runRunnerDevspaceSmoke,
  runRunnerEnvironmentSetup,
} from "./devspace.js";
import {
  type RunnerPullRequestSummary,
  renderRunnerPullRequestSummary,
} from "./pr-summary.js";
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
type GatewayReconciler = (
  config: PipelineConfig,
  cwd: string,
  env: Record<string, string | undefined>
) => Promise<GatewayReconcileResult>;

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
  stdout: OutputStream;
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

interface RunnerJobDeliverySummary {
  branch: string;
  commitSha: string | null;
  pullRequestUrl: string | null;
}

export interface RunnerJobOptions {
  createPullRequest?: PullRequestCreator;
  cwd?: string;
  deliverGitBranch?: GitBranchDeliverer;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  onForceExit?: (exitCode: number) => void;
  orchestrator?: string;
  payloadFile?: string;
  pipelineRunner?: PipelineRunner;
  prepareSchedule?: SchedulePreparer;
  prepareWorkspace?: WorkspacePreparer;
  reconcileGateway?: GatewayReconciler;
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
  const { env, payload, stderr, stdout } = prepared.job;

  // Validate auth token before proceeding
  try {
    resolveRunnerEventSinkAuthToken({
      authTokenFile: payload.events.authTokenFile,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    return EXIT_VALIDATION;
  }

  const controller = new AbortController();
  const signalEmitter = options.signalEmitter ?? process;
  const forceExit =
    options.onForceExit ?? ((exitCode: number) => process.exit(exitCode));
  let signalExitCode: number | undefined;
  let signalCount = 0;
  let signalFinalResultRecorded = false;

  const sink = createRunnerSink({
    events: payload.events,
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
    const { config, task, workflowId, workspace } = await prepareReadyWorkspace(
      options,
      payload,
      env,
      sink
    );
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

    await handleRuntimeDelivery({
      config,
      options,
      payload,
      result,
      sink,
      stdout,
      workspace,
    });

    recordFinalResultIfMissing(sink, result.outcome, result.plan.workflowId, {
      sawWorkflowFinish,
      signalFinalResultRecorded,
    });
    reportRuntimeFailureDetails(result, stderr);
    const flushFailure = await flushAndReport(sink.flush, stderr);
    if (flushFailure && !signalExitCode) {
      return EXIT_STARTUP;
    }
    return signalExitCode ?? exitCodeForRuntimeResult(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`${message}\n`);
    await recordRunnerStartupFailure(sink, message, stderr, {
      cancelled: signalExitCode !== undefined,
    });
    recordFinalResultIfMissing(sink, "FAIL", RUNNER_SCHEDULE_ENTRYPOINT, {
      sawWorkflowFinish,
      signalFinalResultRecorded,
    });
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

async function recordRunnerStartupFailure(
  sink: RunnerEventSink,
  message: string,
  stderr: OutputStream,
  state: { cancelled: boolean }
): Promise<void> {
  if (state.cancelled) {
    return;
  }

  sink.recordRunnerJobPhase("runner.startup.failed", "runner startup failed", {
    error: message,
    status: "failed",
  });
  await flushAndReport(sink.flush, stderr);
}

function recordFinalResultIfMissing(
  sink: RunnerEventSink,
  outcome: "CANCELLED" | "FAIL" | "PASS",
  workflowId: string,
  state: { sawWorkflowFinish: boolean; signalFinalResultRecorded: boolean }
): void {
  if (state.sawWorkflowFinish || state.signalFinalResultRecorded) {
    return;
  }
  sink.recordFinalResult(outcome, workflowId);
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
  await recordRunnerJobPhase(
    sink,
    "workspace.prepared",
    "runner workspace prepared",
    {
      worktreePath: workspace.worktreePath,
    }
  );
  const readiness = assertRunnerDevspaceReady(workspace.worktreePath);
  const config = applyRunnerOrchestrator(
    readiness.config,
    options.orchestrator
  );
  const runnerEnv = {
    ...workspace.env,
    PIPELINE_TARGET_PATH: workspace.worktreePath,
  };
  workspace.env = runnerEnv;
  if (config.mcp_gateway) {
    const reconcile = options.reconcileGateway ?? reconcileMcpGateway;
    const result = await reconcile(config, workspace.worktreePath, runnerEnv);
    await recordRunnerJobPhase(
      sink,
      "mcp.gateway.reconciled",
      "MCP gateway reconciled",
      {
        backendCount: result.backendCount,
        configPath: result.configPath,
        readinessFailures: result.readinessFailures,
        workspacePath: result.workspacePath,
      }
    );
  }
  await recordRunnerJobPhase(
    sink,
    "environment.ready",
    "runner environment ready"
  );
  const setupStatus = await runRunnerEnvironmentSetup({
    config,
    env: workspace.env,
    runCommand: options.runDevspaceCommand,
    worktreePath: workspace.worktreePath,
  });
  await recordRunnerJobPhase(
    sink,
    `environment.setup.${setupStatus}`,
    `runner environment setup ${setupStatus}`
  );
  const task = resolveRunnerTask(payload.task, workspace.worktreePath);
  const prepareSchedule =
    options.prepareSchedule ??
    (options.pipelineRunner
      ? useConfiguredDefaultWorkflow
      : generateRunnerSchedule);
  const compiled = await prepareSchedule(
    config,
    runnerScheduleTask(payload.task, task),
    workspace,
    sink
  );
  return {
    config: compiled.config,
    readiness,
    task,
    workflowId: compiled.workflowId,
    workspace,
  };
}

async function recordRunnerJobPhase(
  sink: RunnerEventSink,
  phase: string,
  message: string,
  output?: Record<string, unknown>
): Promise<void> {
  sink.recordRunnerJobPhase(phase, message, output);
  await sink.flush();
}

function applyRunnerOrchestrator(
  config: PipelineConfig,
  orchestrator: string | undefined
): PipelineConfig {
  if (!orchestrator) {
    return config;
  }
  if (!(orchestrator in config.runners)) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_VALIDATION_ERROR",
      `Runner job orchestrator '${orchestrator}' is not declared in pipeline runners`,
      [
        {
          message: `runner '${orchestrator}' is required for runner jobs`,
          path: `runners.${orchestrator}`,
        },
      ]
    );
  }

  const selected = orchestrator as "codex" | "opencode";
  const next = structuredClone(config);
  for (const profile of Object.values(next.profiles)) {
    if (profile.runner === "codex" || profile.runner === "opencode") {
      profile.runner = selected;
    }
  }
  return next;
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

function runnerScheduleTask(task: RunnerTask, resolvedTask: string): string {
  return task.kind === "ticket" ? task.id : resolvedTask;
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
  await recordRunnerJobPhase(
    sink,
    "schedule.generated",
    "runner schedule generated",
    {
      path: result.path,
    }
  );
  const compiled = compileScheduleArtifact(
    config,
    result.artifact,
    workspace.worktreePath
  );
  return { config: compiled.config, workflowId: compiled.workflowId };
}

function shouldDeliverRuntimeResult(
  result: PipelineRuntimeResult,
  _payload: RunnerJobPayload
): boolean {
  return result.outcome === "PASS";
}

async function handleRuntimeDelivery(input: {
  config: PipelineConfig;
  options: RunnerJobOptions;
  payload: RunnerJobPayload;
  result: PipelineRuntimeResult;
  sink: RunnerEventSink;
  stdout: OutputStream;
  workspace: RunnerWorkspacePreparation;
}): Promise<void> {
  if (!shouldDeliverRuntimeResult(input.result, input.payload)) {
    return;
  }
  const delivery = await deliverRuntimeResult(
    input.options,
    input.payload,
    input.workspace,
    input.config,
    input.sink,
    input.result,
    input.options.orchestrator
  );
  if (delivery) {
    reportDeliverySummary(delivery, input.stdout);
  }
}

async function deliverRuntimeResult(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  workspace: RunnerWorkspacePreparation,
  config: PipelineConfig,
  sink: RunnerEventSink,
  result: PipelineRuntimeResult,
  orchestrator: string | undefined
): Promise<RunnerJobDeliverySummary | null> {
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
  const branchDelivery = await deliverRunnerGitBranchWithPhase(
    options,
    payload,
    workspace,
    config,
    sink
  );
  sink.recordRunnerJobPhase("delivery.git", "runner git branch pushed", {
    branch: branchDelivery.branch,
    commitSha: branchDelivery.commitSha,
  });
  const pullRequest = await createRunnerPullRequestWithPhase(
    options,
    payload,
    workspace,
    sink,
    branchDelivery.branch,
    payload.delivery.pullRequest
      ? renderRunnerPullRequestSummary({
          metadata: {
            branch: branchDelivery.branch,
            commitSha: branchDelivery.commitSha,
            orchestrator: orchestrator ?? config.orchestrator.profile,
            scheduleId: payload.run.id,
            schedulePath: `.pipeline/runs/${payload.run.id}/schedule.yaml`,
          },
          payload,
          result,
        })
      : undefined
  );
  if (pullRequest) {
    sink.recordRunnerJobPhase(
      "delivery.pull_request",
      "runner pull request created",
      { url: pullRequest.url }
    );
  }
  return {
    branch: branchDelivery.branch,
    commitSha: branchDelivery.commitSha,
    pullRequestUrl: pullRequest?.url ?? null,
  };
}

function reportDeliverySummary(
  delivery: RunnerJobDeliverySummary,
  stdout: OutputStream
): void {
  if (!delivery.pullRequestUrl) {
    return;
  }
  stdout.write("Runner delivery complete:\n");
  stdout.write(`- branch: ${delivery.branch}\n`);
  if (delivery.commitSha) {
    stdout.write(`- commit: ${delivery.commitSha}\n`);
  }
  stdout.write(`- pull_request: ${delivery.pullRequestUrl}\n`);
}

async function deliverRunnerGitBranchWithPhase(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  workspace: RunnerWorkspacePreparation,
  config: PipelineConfig,
  sink: RunnerEventSink
) {
  try {
    return await deliverRunnerGitBranch(
      options,
      payload,
      workspace.worktreePath,
      workspace.env,
      config
    );
  } catch (err) {
    sink.recordRunnerJobPhase(
      "delivery.git.failed",
      "runner git branch delivery failed",
      { error: errorMessage(err) }
    );
    throw err;
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
  sink: RunnerEventSink,
  branch: string,
  pullRequestSummary?: RunnerPullRequestSummary
) {
  if (!payload.delivery.pullRequest) {
    return null;
  }
  if (!pullRequestSummary) {
    throw new Error("Runner PR delivery requires a pull request summary");
  }
  try {
    return await createRunnerPullRequest(
      options,
      payload,
      workspace.worktreePath,
      workspace.env,
      branch,
      pullRequestSummary
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

function deliverRunnerGitBranch(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  worktreePath: string,
  env: Record<string, string | undefined>,
  config: PipelineConfig
) {
  const deliver = options.deliverGitBranch ?? deliverGitBranch;
  return deliver({
    committer: config.runner_job.git.committer,
    env,
    payload,
    worktreePath,
  });
}

function createRunnerPullRequest(
  options: RunnerJobOptions,
  payload: RunnerJobPayload,
  worktreePath: string,
  env: Record<string, string | undefined>,
  branch: string,
  pullRequestSummary: RunnerPullRequestSummary
) {
  const create = options.createPullRequest ?? createPullRequest;
  return create({
    branch,
    env,
    payload,
    pullRequestSummary,
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

const VALID_ORCHESTRATORS = new Set(["codex", "opencode"]);

function prepareRunnerJob(options: RunnerJobOptions): PrepareRunnerJobResult {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;

  const orchestrator = options.orchestrator;
  if (orchestrator !== undefined && !VALID_ORCHESTRATORS.has(orchestrator)) {
    stderr.write(
      `Invalid orchestrator '${orchestrator}'. Must be 'codex' or 'opencode'.\n`
    );
    return { exitCode: EXIT_VALIDATION };
  }

  const payloadFilePath = options.payloadFile;
  if (!payloadFilePath) {
    stderr.write("Runner payload file is required. Use --payload-file.\n");
    return { exitCode: EXIT_VALIDATION };
  }

  let payloadRaw: string;
  try {
    payloadRaw = readFileSync(payloadFilePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Payload file error: ${message}\n`);
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

  return { job: { env, payload: payload.payload, stderr, stdout } };
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
    try {
      const sink = createRunnerSink({
        events: failure.recoverable.events,
        fetch: options.fetch,
        runId: failure.recoverable.run.id,
      });
      sink.recordSchemaValidationFailure(
        failure.error.message,
        failure.error.issues,
        RUNNER_SCHEDULE_ENTRYPOINT
      );
      await flushAndReport(sink.flush, failure.stderr);
    } catch {
      // Sink creation failed (e.g., missing auth token) — validation
      // failure is still reported via the exit code.
    }
  }
  return EXIT_VALIDATION;
}

function createRunnerSink(options: {
  events: RunnerJobPayload["events"];
  fetch?: FetchLike;
  runId: string;
}): RunnerEventSink {
  const authToken = resolveRunnerEventSinkAuthToken({
    authTokenFile: options.events.authTokenFile,
  });
  return createRunnerEventSink({
    authHeader: options.events.authHeader,
    authToken,
    fetch: options.fetch,
    runId: options.runId,
    url: options.events.url,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportRuntimeFailureDetails(
  result: PipelineRuntimeResult,
  stderr: OutputStream
): void {
  if (result.outcome !== "FAIL") {
    return;
  }
  const details = [
    ...result.failureDetails,
    ...result.hookFailures,
    ...result.gates
      .filter((gate) => !gate.passed)
      .map((gate) => ({
        evidence: gate.evidence,
        gate: gate.gateId,
        reason: gate.reason ?? "gate failed",
      })),
  ];
  if (details.length === 0) {
    stderr.write("Runtime failed without failure details.\n");
    return;
  }
  stderr.write("Runtime failed:\n");
  for (const detail of details) {
    stderr.write(`- gate: ${detail.gate}; reason: ${detail.reason}\n`);
    for (const evidence of detail.evidence ?? []) {
      stderr.write(`  evidence: ${evidence}\n`);
    }
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
