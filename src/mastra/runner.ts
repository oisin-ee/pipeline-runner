import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { PipelineConfig, RunnerType } from "./config.js";

export type Harness = "claude" | "codex" | "kimi" | "opencode" | "pi";
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

export type RunnerStrategy = "native" | "subprocess";

export interface RunnerLaunchPlan {
  agentId?: string;
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string>;
  nodeId: string;
  outputFormat: string;
  runnerId: string;
  strategy: RunnerStrategy;
  timeoutMs: number;
  type: RunnerType;
}

export interface RunnerLaunchInput {
  agentId?: string;
  contextFile?: string | null;
  nodeId: string;
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

function optionalModelArgs(harness: Harness): string[] {
  const model =
    harness === "opencode"
      ? (process.env.PIPELINE_OPENCODE_MODEL ??
        "opencode/deepseek-v4-flash-free")
      : process.env[`PIPELINE_${harness.toUpperCase()}_MODEL`];
  return model ? ["--model", model] : [];
}

/**
 * Per-harness argv shape, excluding the leading harness binary name.
 */
function harnessArgv(
  harness: Exclude<Harness, "pi">,
  prompt: string,
  worktreePath: string,
  contextFile: string | null
): string[] {
  switch (harness) {
    case "claude":
      // Claude's --print mode just takes one big prompt; we prepend the
      // context the way spawnClaude used to.
      return ["--print", ...optionalModelArgs(harness), "-p", prompt];
    case "codex":
      // --sandbox workspace-write: codex's default sandbox is read-only, which
      // makes the test-writer / code-writer / learn phases unable to produce
      // file artifacts. workspace-write scopes writes to the worktree.
      return [
        "exec",
        "--json",
        ...optionalModelArgs(harness),
        "--sandbox",
        "workspace-write",
        "--config",
        'approval_policy="never"',
        "--skip-git-repo-check",
        prompt,
        "-C",
        worktreePath,
      ];
    case "opencode":
      return contextFile
        ? [
            "run",
            "--format",
            "json",
            ...optionalModelArgs(harness),
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
            ...optionalModelArgs(harness),
            "--dangerously-skip-permissions",
            "--dir",
            worktreePath,
            prompt,
          ];
    case "kimi":
      return ["--print", ...optionalModelArgs(harness), prompt];
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
  if (harness === "pi") {
    return execaHarnessPi(prompt, contextFile, worktreePath);
  }

  // Claude reads stdin as part of `--print` only when piped; we prepend the
  // loaded context to the prompt string instead (matches the prior spawnClaude
  // semantics).
  let effectivePrompt = prompt;
  if (harness === "claude") {
    const context = await loadContext(contextFile);
    effectivePrompt = context ? `${context}\n${prompt}` : prompt;
  }

  if (harness === "opencode") {
    ensureOpencodeGitExcludes(worktreePath);
  }

  // Codex's `exec` reads context via stdin (matches the prior spawnCodex).
  const input =
    harness === "codex" && contextFile
      ? await loadContext(contextFile)
      : undefined;

  const argv = harnessArgv(harness, effectivePrompt, worktreePath, contextFile);
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
 * Pi-specific path.
 */
async function execaHarnessPi(
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  const context = await loadContext(contextFile);
  const effectivePrompt = context ? `${context}\n${prompt}` : prompt;
  const argv = [
    "--print",
    "--mode",
    "json",
    ...optionalModelArgs("pi"),
    "--no-session",
    effectivePrompt,
  ];
  try {
    const result = await execa("pi", argv, {
      cwd: worktreePath,
      stdin: "ignore",
      timeout: Number(process.env.PIPELINE_AGENT_TIMEOUT_MS ?? 300_000),
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
  const agent = input.agentId ? config.agents[input.agentId] : undefined;
  if (input.agentId && !agent) {
    throw new RunnerCapabilityError(`agent '${input.agentId}' is not declared`);
  }
  const runnerId = agent?.runner ?? "command";
  const runner = config.runners[runnerId];
  if (!runner) {
    throw new RunnerCapabilityError(`runner '${runnerId}' is not declared`);
  }
  const outputFormat = agent?.output?.format ?? "text";
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
  const env = {};
  const base = {
    agentId: input.agentId,
    cwd: input.worktreePath,
    env,
    nodeId: input.nodeId,
    outputFormat,
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
      strategy: "subprocess",
    };
  }

  const strategy = nativeStrategy(config, input, runnerId);
  return {
    ...base,
    args:
      runner.type === "pi"
        ? piArgv(input.prompt)
        : harnessArgv(
            runner.type,
            input.prompt,
            input.worktreePath,
            input.contextFile ?? null
          ),
    command,
    strategy,
  };
}

function piArgv(prompt: string): string[] {
  return [
    "--print",
    "--mode",
    "json",
    ...optionalModelArgs("pi"),
    "--no-session",
    prompt,
  ];
}

function nativeStrategy(
  config: PipelineConfig,
  input: RunnerLaunchInput,
  runnerId: string
): RunnerStrategy {
  const runner = config.runners[runnerId];
  const agent = input.agentId ? config.agents[input.agentId] : undefined;
  if (!(runner?.capabilities.native_subagents && agent)) {
    return "subprocess";
  }
  if (runner.type === "command") {
    return "subprocess";
  }
  return "native";
}

function renderArgv(args: string[], prompt: string, cwd: string): string[] {
  return args.map((arg) =>
    arg.replaceAll("{{prompt}}", prompt).replaceAll("{{cwd}}", cwd)
  );
}

export async function runLaunchPlan(
  plan: RunnerLaunchPlan
): Promise<AgentResult> {
  try {
    const result = await execa(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      timeout: plan.timeoutMs,
    });
    return {
      argv: plan.args,
      exitCode: result.exitCode ?? 0,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  } catch (err) {
    const e = err as {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
    return {
      argv: plan.args,
      exitCode: e.exitCode ?? 1,
      stderr: e.stderr ?? "",
      stdout: e.stdout ?? "",
      timedOut: Boolean(e.timedOut),
    };
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
