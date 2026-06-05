import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { PipelineConfig, RunnerType } from "./config.js";
import { resolveFileReference } from "./path-refs.js";
import { tomlValue } from "./toml.js";

export type Harness = "codex" | "opencode";
export type AgentRole =
  | "researcher"
  | "test-writer"
  | "code-writer"
  | "verifier";

export interface AgentResult {
  argv?: string[];
  exitCode: number;
  stderr?: string;
  stdout: string;
  timedOut?: boolean;
}

export interface RunnerExecutionOptions {
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

export interface RunnerLaunchPlan {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  nodeId: string;
  outputFormat: string;
  profileId?: string;
  runnerId: string;
  timeoutMs: number;
  type: RunnerType;
}

export interface RunnerLaunchInput {
  contextFile?: string | null;
  nodeId: string;
  profileId?: string;
  prompt: string;
  worktreePath: string;
}

export class RunnerCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerCapabilityError";
  }
}

async function loadContext(contextFile: string | null): Promise<string> {
  if (!contextFile) {
    return "";
  }
  return await readFile(contextFile, "utf8");
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
  harness: Harness,
  runner?: PipelineConfig["runners"][string],
  actor?: ActorConfig
): string[] {
  const model =
    actor?.model ??
    runner?.model ??
    (harness === "opencode"
      ? (process.env.PIPELINE_OPENCODE_MODEL ??
        "opencode/deepseek-v4-flash-free")
      : process.env[`PIPELINE_${harness.toUpperCase()}_MODEL`]);
  return model ? ["--model", model] : [];
}

type ProfileConfig = PipelineConfig["profiles"][string];
type ActorConfig = ProfileConfig;

interface NativeArgOptions {
  actor?: ActorConfig;
  config?: PipelineConfig;
  nodeId?: string;
  runner?: PipelineConfig["runners"][string];
}

/**
 * Per-harness argv shape, excluding the leading harness binary name.
 */
function harnessArgv(
  harness: Harness,
  prompt: string,
  worktreePath: string,
  contextFile: string | null,
  options: NativeArgOptions = {}
): string[] {
  const skillArgs = skillArgsFor(
    harness,
    options.config,
    options.actor,
    worktreePath
  );
  switch (harness) {
    case "codex":
      return [
        "exec",
        "--json",
        "-C",
        worktreePath,
        ...optionalModelArgs(harness, options.runner, options.actor),
        ...(options.config ? ["--ignore-user-config"] : []),
        ...skillArgs,
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        prompt,
      ];
    case "opencode":
      return contextFile
        ? [
            "run",
            "--format",
            "json",
            ...optionalModelArgs(harness, options.runner, options.actor),
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
            ...optionalModelArgs(harness, options.runner, options.actor),
            ...skillArgs,
            "--dangerously-skip-permissions",
            "--dir",
            worktreePath,
            prompt,
          ];
    default: {
      const _exhaustive: never = harness;
      throw new Error(
        `Unhandled harness in harnessArgv: ${String(_exhaustive)}`
      );
    }
  }
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

  // Codex's `exec` reads context via stdin (matches the prior spawnCodex).
  const input =
    harness === "codex" && contextFile
      ? await loadContext(contextFile)
      : undefined;

  const argv = harnessArgv(harness, prompt, worktreePath, contextFile);
  try {
    const result = await execa(harness, argv, {
      cwd: worktreePath,
      stdin: input === undefined ? "ignore" : "pipe",
      timeout: Number(process.env.PIPELINE_AGENT_TIMEOUT_MS ?? 300_000),
      ...(input === undefined ? {} : { input }),
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

  const command = runner.command ?? runner.type;
  const timeoutMs = Number(process.env.PIPELINE_AGENT_TIMEOUT_MS ?? 300_000);
  const env: Record<string, string | undefined> = {};
  const base = {
    cwd: input.worktreePath,
    env,
    nodeId: input.nodeId,
    outputFormat,
    profileId: input.profileId,
    runnerId,
    timeoutMs,
    type: runner.type,
  };

  if (runner.type === "command") {
    if (!runner.command) {
      throw new RunnerCapabilityError(
        `command runner '${runnerId}' must declare command`
      );
    }
    return {
      ...base,
      args: renderArgv(runner.args ?? [], input.prompt, input.worktreePath),
      command,
    };
  }

  return {
    ...base,
    args: harnessArgv(
      runner.type,
      input.prompt,
      input.worktreePath,
      input.contextFile ?? null,
      {
        actor,
        config,
        nodeId: input.nodeId,
        runner,
      }
    ),
    command,
  };
}

function skillArgsFor(
  runnerType: RunnerType,
  config: PipelineConfig | undefined,
  actor: ActorConfig | undefined,
  worktreePath: string
): string[] {
  const shouldValidatePaths = existsSync(worktreePath);
  const paths = (actor?.skills ?? []).flatMap((id) => {
    const path = config?.skills[id]?.path;
    const absolutePath = path
      ? resolveFileReference(worktreePath, path)
      : undefined;
    if (!absolutePath) {
      return [];
    }
    return shouldValidatePaths && !existsSync(absolutePath)
      ? []
      : [absolutePath];
  });
  if (paths.length === 0) {
    return [];
  }
  if (runnerType === "codex") {
    return [
      "--config",
      `skills.config=${tomlValue(
        paths.map((path) => ({ enabled: true, path }))
      )}`,
    ];
  }
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
  let result: AgentResult;
  try {
    const subprocess = await execa(plan.command, plan.args, {
      cancelSignal: options.signal,
      cwd: plan.cwd,
      env: plan.env,
      stdin: "ignore",
      timeout: plan.timeoutMs,
    });
    result = {
      argv: plan.args,
      exitCode: subprocess.exitCode ?? 0,
      stderr: subprocess.stderr ?? "",
      stdout: subprocess.stdout ?? "",
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
  if (!cleanupError) {
    return result;
  }
  return {
    ...result,
    stderr: [result.stderr, cleanupError].filter(Boolean).join("\n"),
  };
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
