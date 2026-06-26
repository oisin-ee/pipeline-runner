import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { Data } from "effect";
import { execa } from "execa";
import type { PipelineConfig, RunnerType } from "./config";
import {
  createProtectedPathGuard,
  type ProtectedPathGuard,
  type ProtectedPathViolation,
} from "./runtime/protected-paths/protected-paths";

export type Harness = "opencode";
export type AgentRole =
  | "researcher"
  | "test-writer"
  | "code-writer"
  | "verifier";

/**
 * Agent-output boundary, layer 1 of 4 (PIPE-74 B3). `AgentResult` is the RAW
 * terminal result of one runner subprocess/session: exit code, accumulated
 * stdout/stderr, and execution metadata. It carries no parsing or semantic
 * interpretation — downstream layers refine it:
 *   1. {@link AgentResult}            — raw subprocess result (this type)
 *   2. {@link RunnerOutputEvent}      — a live stream chunk during execution
 *   3. RuntimeNormalizedOutput        — adapter-extracted text + evidence
 *      (src/runtime/opencode-adapter.ts)
 *   4. RuntimeStructuredOutput        — parsed + schema-validated output
 *      (src/runtime/contracts/contracts.ts)
 */
export interface AgentResult {
  argv?: string[];
  exitCode: number;
  /** opencode session id when driven through the SDK executor (PIPE-73). */
  sessionId?: string;
  stderr?: string;
  stdout: string;
  timedOut?: boolean;
}

/**
 * Agent-output boundary, layer 2 of 4 (PIPE-74 B3). A single incremental chunk
 * of a runner's live output stream, surfaced via
 * {@link RunnerExecutionOptions.onOutput} while the subprocess is still
 * running — distinct from {@link AgentResult}, which is the final accumulated
 * result.
 */
export interface RunnerOutputEvent {
  chunk: string;
  nodeId: string;
  stream: "stderr" | "stdout";
}

/**
 * Lowest layer of the runtime-options stack (PIPE-74 B3): the per-invocation
 * controls a runner executor needs — cancellation and live-output streaming.
 * Widened by the runtime layers above it:
 *   RunnerExecutionOptions (this type)
 *     < PipelineRuntimeOptions (src/runtime/contracts/contracts.ts)
 *     < ScheduledWorkflowTaskRuntimeOptions (src/pipeline-runtime.ts)
 */
export interface RunnerExecutionOptions {
  onOutput?: (event: RunnerOutputEvent) => void;
  signal?: AbortSignal;
}

export interface AgentRunRequest {
  contextFile: string | null;
  harness: Harness;
  prompt: string;
  role: AgentRole;
  /** Optional ticket id reserved for YAML-driven adapters in the v1 runtime. */
  ticketId?: string | null;
  worktreePath: string;
}

export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentResult>;
}

type ReasoningEffort = NonNullable<
  PipelineConfig["profiles"][string]["reasoning_effort"]
>;

export interface RunnerLaunchPlan {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  idleTimeoutMs?: number;
  model?: string;
  nodeId: string;
  outputFormat: string;
  profileId?: string;
  /**
   * PIPE-90.12: glob patterns (from the profile's `filesystem.protected`) the
   * executing agent must not modify. Snapshotted before launch and reverted
   * afterwards by {@link runLaunchPlan}.
   */
  protectedPaths?: readonly string[];
  runnerId: string;
  timeoutMs?: number;
  type: RunnerType;
  variant?: ReasoningEffort;
}

export interface RunnerLaunchInput {
  contextFile?: string | null;
  model?: string;
  nodeId: string;
  profileId?: string;
  prompt: string;
  reasoningEffort?: ReasoningEffort;
  worktreePath: string;
}

export class RunnerCapabilityError extends Data.TaggedError(
  "RunnerCapabilityError"
)<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

const OPENCODE_EXCLUDES = [
  "node_modules/",
  ".opencode/node_modules/",
  ".mastra/",
  "dist/",
  "build/",
  "coverage/",
];
const LINE_RE = /\r?\n/;

function ensureOpencodeGitExcludes(worktreePath: string): void {
  const excludePath = join(worktreePath, ".git", "info", "exclude");
  if (!existsSync(excludePath)) {
    return;
  }
  const existing = readFileSync(excludePath, "utf8");
  const missing = OPENCODE_EXCLUDES.filter(
    (entry) => !existing.split(LINE_RE).includes(entry)
  );
  if (missing.length === 0) {
    return;
  }
  mkdirSync(join(worktreePath, ".git", "info"), { recursive: true });
  appendFileSync(
    excludePath,
    `${existing.endsWith("\n") ? "" : "\n"}# oisin-pipeline opencode excludes\n${missing.join("\n")}\n`
  );
}

function optionalModelArgs(
  runner?: PipelineConfig["runners"][string],
  actor?: ActorConfig,
  selectedModel?: string
): string[] {
  const model = resolveOpencodeModel(runner, actor, selectedModel);
  return model ? ["--model", model] : [];
}

function resolveOpencodeModel(
  runner?: PipelineConfig["runners"][string],
  actor?: ActorConfig,
  selectedModel?: string
): string | undefined {
  return firstDefinedModel([
    selectedModel,
    actorModel(actor),
    runnerModel(runner),
  ]);
}

function firstDefinedModel(
  values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined);
}

function actorModel(actor?: ActorConfig): string | undefined {
  return actor?.model;
}

function runnerModel(
  runner?: PipelineConfig["runners"][string]
): string | undefined {
  return runner?.model;
}

type ProfileConfig = PipelineConfig["profiles"][string];
type ActorConfig = ProfileConfig;

interface NativeArgOptions {
  actor?: ActorConfig;
  config?: PipelineConfig;
  model?: string;
  nodeId?: string;
  runner?: PipelineConfig["runners"][string];
  variant?: ReasoningEffort;
}

function optionalVariantArgs(variant?: ReasoningEffort): string[] {
  return variant ? ["--variant", variant] : [];
}

/**
 * Per-harness argv shape, excluding the leading harness binary name.
 */
function harnessArgv(
  prompt: string,
  worktreePath: string,
  contextFile: string | null,
  options: NativeArgOptions = {}
): string[] {
  const skillArgs = skillArgsFor();
  return contextFile
    ? [
        "run",
        "--format",
        "json",
        ...optionalModelArgs(options.runner, options.actor, options.model),
        ...optionalVariantArgs(options.variant),
        ...skillArgs,
        "--dangerously-skip-permissions",
        "--dir",
        worktreePath,
        prompt,
        "--file",
        contextFile,
      ]
    : [
        "run",
        "--format",
        "json",
        ...optionalModelArgs(options.runner, options.actor, options.model),
        ...optionalVariantArgs(options.variant),
        ...skillArgs,
        "--dangerously-skip-permissions",
        "--dir",
        worktreePath,
        prompt,
      ];
}

/**
 * Spawn the selected harness directly for a single agent boundary.
 */
async function execaHarness(
  harness: Harness,
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  if (harness === "opencode") {
    ensureOpencodeGitExcludes(worktreePath);
  }

  const argv = harnessArgv(prompt, worktreePath, contextFile);
  try {
    const result = await execa(harness, argv, {
      cwd: worktreePath,
      stdin: "ignore",
      ...agentTimeoutOption(),
    });
    return {
      argv,
      exitCode: result.exitCode ?? 0,
      stderr: result.stderr ?? "",
      stdout: result.stdout,
    };
  } catch (err) {
    const e = err as {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
    return {
      argv,
      exitCode: e.exitCode ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
      timedOut: Boolean(e.timedOut),
    };
  }
}

/**
 * Strict adapter: each phase runs as its own harness subprocess.
 */
export const hardAgentAdapter: AgentAdapter = {
  run({ harness, prompt, contextFile, worktreePath }: AgentRunRequest) {
    return execaHarness(harness, prompt, contextFile, worktreePath);
  },
};

export function createRunnerLaunchPlan(
  config: PipelineConfig,
  input: RunnerLaunchInput
): RunnerLaunchPlan {
  const profile = input.profileId
    ? config.profiles[input.profileId]
    : undefined;
  if (input.profileId && !profile) {
    throw new RunnerCapabilityError(
      `profile '${input.profileId}' is not declared`
    );
  }
  return createActorLaunchPlan(
    config,
    input,
    profile,
    profile?.runner ?? "command"
  );
}

export function createOrchestratorLaunchPlan(
  config: PipelineConfig,
  input: Omit<RunnerLaunchInput, "profileId">
): RunnerLaunchPlan {
  if (!config.orchestrator) {
    throw new RunnerCapabilityError("orchestrator profile is not configured");
  }
  return createActorLaunchPlan(
    config,
    {
      ...input,
      profileId: config.orchestrator.profile,
    },
    config.profiles[config.orchestrator.profile],
    config.profiles[config.orchestrator.profile]?.runner ?? "command"
  );
}

// Resolve the actor's requested output format and reject it up front when the
// selected runner cannot produce it, so the launch plan never carries an
// unsupported contract.
function resolveOutputFormat(
  actor: ActorConfig | undefined,
  runner: PipelineConfig["runners"][string],
  runnerId: string
): string {
  const outputFormat =
    actor && "output" in actor ? (actor.output?.format ?? "text") : "text";
  if (
    runner.capabilities.output_formats &&
    !runner.capabilities.output_formats.includes(outputFormat)
  ) {
    throw new RunnerCapabilityError(
      `runner '${runnerId}' does not support output format '${outputFormat}'`
    );
  }
  return outputFormat;
}

// Render the argv for a `command`-type runner, failing fast when it omits the
// command it is required to declare.
function commandRunnerArgs(
  runner: PipelineConfig["runners"][string],
  runnerId: string,
  input: RunnerLaunchInput
): string[] {
  if (!runner.command) {
    throw new RunnerCapabilityError(
      `command runner '${runnerId}' must declare command`
    );
  }
  return renderArgv(runner.args ?? [], input.prompt, input.worktreePath);
}

function createActorLaunchPlan(
  config: PipelineConfig,
  input: RunnerLaunchInput,
  actor: ActorConfig | undefined,
  runnerId: string
): RunnerLaunchPlan {
  const runner = config.runners[runnerId];
  if (!runner) {
    throw new RunnerCapabilityError(`runner '${runnerId}' is not declared`);
  }
  const command = runner.command ?? runner.type;
  const env: Record<string, string | undefined> = {};
  const { model, variant } = resolveLaunchModel(input, actor, runner);
  const base = {
    cwd: input.worktreePath,
    env,
    idleTimeoutMs: agentIdleTimeoutMsFromEnv(),
    model,
    nodeId: input.nodeId,
    outputFormat: resolveOutputFormat(actor, runner, runnerId),
    profileId: input.profileId,
    ...protectedPathsField(actor),
    runnerId,
    timeoutMs: actor?.timeout_ms ?? agentTimeoutMsFromEnv(),
    type: runner.type,
    variant,
  };

  if (runner.type === "command") {
    return {
      ...base,
      args: commandRunnerArgs(runner, runnerId, input),
      command,
    };
  }

  return {
    ...base,
    args: harnessArgv(
      input.prompt,
      input.worktreePath,
      input.contextFile ?? null,
      {
        actor,
        config,
        model: input.model,
        nodeId: input.nodeId,
        runner,
        variant,
      }
    ),
    command,
  };
}

/**
 * Reasoning effort applies as the opencode model variant, but only the GPT-5
 * family (openai provider through broker auth) defines variants. For any other
 * selected fallback model, omit the variant so opencode does not reject an
 * unknown variant.
 */
function resolveVariant(
  effort: ReasoningEffort | undefined,
  model: string | undefined
): ReasoningEffort | undefined {
  if (!(effort && model)) {
    return;
  }
  return model.startsWith("openai/") ? effort : undefined;
}

/**
 * Resolve the selected model and its opencode variant from the launch input,
 * actor (profile), and runner, preferring the most specific source.
 */
function resolveLaunchModel(
  input: RunnerLaunchInput,
  actor: ActorConfig | undefined,
  runner: PipelineConfig["runners"][string]
): { model: string | undefined; variant: ReasoningEffort | undefined } {
  const model = input.model ?? actor?.model ?? runner.model;
  const effort =
    input.reasoningEffort ?? actor?.reasoning_effort ?? runner.reasoning_effort;
  return { model, variant: resolveVariant(effort, model) };
}

// PIPE-90.12: lift the profile's protected glob set onto the launch plan so the
// runtime integrity guard can enforce it. Returns an empty object when the
// profile declares none, keeping it absent from the plan.
function protectedPathsField(actor: ActorConfig | undefined): {
  protectedPaths?: readonly string[];
} {
  const protectedPaths = actor?.filesystem?.protected;
  return protectedPaths && protectedPaths.length > 0 ? { protectedPaths } : {};
}

function skillArgsFor(): string[] {
  return [];
}

function renderArgv(args: string[], prompt: string, cwd: string): string[] {
  return args.map((arg) =>
    arg.replaceAll("{{prompt}}", prompt).replaceAll("{{cwd}}", cwd)
  );
}

export async function runLaunchPlan(
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions = {}
): Promise<AgentResult> {
  // Snapshot the protected set BEFORE the untrusted agent runs. This closes the
  // `--dangerously-skip-permissions` hole for the CLI/runner transport: even
  // with tool permissions bypassed, any write/delete/redirect to a protected
  // file is reverted and surfaced after the subprocess returns.
  const guard = createProtectedPathGuard(plan.cwd, plan.protectedPaths);
  let result: AgentResult;
  try {
    const subprocess = execa(plan.command, plan.args, {
      cancelSignal: options.signal,
      cwd: plan.cwd,
      env: plan.env,
      stdin: "ignore",
      ...timeoutOption(plan.timeoutMs),
    });
    streamSubprocessOutput(plan, subprocess, options);
    const completed = await subprocess;
    result = {
      argv: plan.args,
      exitCode: completed.exitCode ?? 0,
      stderr: completed.stderr ?? "",
      stdout: completed.stdout ?? "",
    };
  } catch (err) {
    const e = err as {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
    result = {
      argv: plan.args,
      exitCode: e.exitCode ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
      timedOut: Boolean(e.timedOut),
    };
  }
  const cleanupError = cleanupOpencodeRuntimeDir(plan);
  return finalizeLaunchResult(result, guard, cleanupError);
}

// PIPE-90.12: a protected-path tampering attempt is a genuine task failure
// (reward-hacking), not an infra fault — exit 1 so Argo does not reschedule.
const PROTECTED_PATH_VIOLATION_EXIT_CODE = 1;

function finalizeLaunchResult(
  result: AgentResult,
  guard: ProtectedPathGuard,
  cleanupError: string | undefined
): AgentResult {
  const violations = guard.verifyAndRestore();
  const violationMessage = protectedPathViolationMessage(violations);
  const stderr = [result.stderr, violationMessage, cleanupError]
    .filter(Boolean)
    .join("\n");
  const exitCode =
    violations.length > 0 && result.exitCode === 0
      ? PROTECTED_PATH_VIOLATION_EXIT_CODE
      : result.exitCode;
  return { ...result, exitCode, stderr };
}

function protectedPathViolationMessage(
  violations: readonly ProtectedPathViolation[]
): string {
  if (violations.length === 0) {
    return "";
  }
  const detail = violations
    .map((violation) => `${violation.path} (${violation.kind})`)
    .join(", ");
  return `Protected-path violation: the agent modified read-only acceptance criteria or adjudicating tests (${detail}); the changes were reverted and the node failed.`;
}

function streamSubprocessOutput(
  plan: RunnerLaunchPlan,
  subprocess: {
    stderr?: {
      on?: (event: "data", listener: (chunk: unknown) => void) => void;
    };
    stdout?: {
      on?: (event: "data", listener: (chunk: unknown) => void) => void;
    };
  },
  options: RunnerExecutionOptions
): void {
  if (!options.onOutput) {
    return;
  }
  subprocess.stdout?.on?.("data", (chunk) => {
    options.onOutput?.({
      chunk: chunkToString(chunk),
      nodeId: plan.nodeId,
      stream: "stdout",
    });
  });
  subprocess.stderr?.on?.("data", (chunk) => {
    options.onOutput?.({
      chunk: chunkToString(chunk),
      nodeId: plan.nodeId,
      stream: "stderr",
    });
  });
}

function chunkToString(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
}

function agentTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.PIPELINE_AGENT_TIMEOUT_MS;
  if (!raw) {
    return;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Default-on idle (inactivity) budget for opencode sessions. Unset env keeps the
// 180s default; an explicit `0` (or invalid) disables the idle watchdog and
// leaves only the wall-clock PIPELINE_AGENT_TIMEOUT_MS backstop.
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 180_000;

function agentIdleTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.PIPELINE_AGENT_IDLE_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_AGENT_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function agentTimeoutOption(): { timeout: number } | Record<string, never> {
  return timeoutOption(agentTimeoutMsFromEnv());
}

function timeoutOption(
  timeoutMs: number | undefined
): { timeout: number } | Record<string, never> {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

function cleanupOpencodeRuntimeDir(plan: RunnerLaunchPlan): string | undefined {
  const runtimeDir = plan.env.PIPELINE_OPENCODE_RUNTIME_DIR;
  if (!runtimeDir || process.env.PIPELINE_KEEP_OPENCODE_RUNTIME_DIR === "1") {
    return;
  }
  try {
    rmSync(runtimeDir, { force: true, recursive: true });
    return;
  } catch (err) {
    return `Failed to remove OpenCode runtime dir ${runtimeDir}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/**
 * Invoke one pipeline agent boundary through the strict subprocess adapter.
 */
export function spawnAgent(
  harness: Harness,
  role: AgentRole,
  prompt: string,
  contextFile: string | null,
  worktreePath: string,
  ticketId: string | null = null
): Promise<AgentResult> {
  return hardAgentAdapter.run({
    contextFile,
    harness,
    prompt,
    role,
    worktreePath,
    ticketId,
  });
}

/**
 * Default subprocess adapter used by pipeline steps.
 */
export const subprocessAgentAdapter: AgentAdapter = hardAgentAdapter;
