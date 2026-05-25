import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string>;
  nodeId: string;
  outputFormat: string;
  profileId?: string;
  runnerId: string;
  strategy: RunnerStrategy;
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
type McpServerConfig = PipelineConfig["mcp_servers"][string];

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
  harness: Exclude<Harness, "pi">,
  prompt: string,
  worktreePath: string,
  contextFile: string | null,
  options: NativeArgOptions = {}
): string[] {
  const tools = options.actor?.tools ?? [];
  const mcpArgs = mcpArgsFor(harness, options.config, options.actor);
  const skillArgs = skillArgsFor(
    harness,
    options.config,
    options.actor,
    worktreePath
  );
  switch (harness) {
    case "claude":
      // Claude's --print mode just takes one big prompt; we prepend the
      // context the way spawnClaude used to.
      return [
        "--print",
        ...optionalModelArgs(harness, options.runner, options.actor),
        ...claudeToolArgs(tools),
        ...mcpArgs,
        ...skillArgs,
        "-p",
        prompt,
      ];
    case "codex":
      // --sandbox workspace-write: codex's default sandbox is read-only, which
      // makes the test-writer / code-writer / learn phases unable to produce
      // file artifacts. workspace-write scopes writes to the worktree.
      // Read-only profiles keep Codex in read-only mode, which is especially
      // important for output repair/finalization passes.
      return [
        "exec",
        "--json",
        "-C",
        worktreePath,
        ...optionalModelArgs(harness, options.runner, options.actor),
        ...mcpArgs,
        ...skillArgs,
        "--sandbox",
        codexSandboxFor(options.actor),
        "--config",
        'approval_policy="never"',
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
            ...mcpArgs,
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
            ...mcpArgs,
            ...skillArgs,
            "--dangerously-skip-permissions",
            "--dir",
            worktreePath,
            prompt,
          ];
    case "kimi":
      return [
        "--print",
        "--work-dir",
        worktreePath,
        ...optionalModelArgs(harness, options.runner, options.actor),
        ...mcpArgs,
        ...skillArgs,
        "--prompt",
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

function codexSandboxFor(actor?: ActorConfig): string {
  return actor?.filesystem?.mode === "read-only"
    ? "read-only"
    : "workspace-write";
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
  const env = runnerEnv(
    runner.type,
    config,
    actor,
    input.worktreePath,
    input.nodeId
  );
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
      strategy: "subprocess",
    };
  }

  const strategy = nativeStrategy(config, input, runnerId);
  return {
    ...base,
    args:
      runner.type === "pi"
        ? piArgv(input.prompt, config, actor, input.worktreePath, runner)
        : harnessArgv(
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
    strategy,
  };
}

function piArgv(
  prompt: string,
  config?: PipelineConfig,
  actor?: ActorConfig,
  worktreePath = process.cwd(),
  runner?: PipelineConfig["runners"][string]
): string[] {
  return [
    "--print",
    "--mode",
    "json",
    ...optionalModelArgs("pi", runner, actor),
    ...piToolArgs(actor?.tools ?? []),
    ...skillArgsFor("pi", config, actor, worktreePath),
    "--no-session",
    prompt,
  ];
}

function claudeToolArgs(tools: string[]): string[] {
  const mapped = tools.flatMap((tool) => {
    const value = new Map([
      ["bash", "Bash"],
      ["edit", "Edit"],
      ["glob", "Glob"],
      ["grep", "Grep"],
      ["list", "LS"],
      ["read", "Read"],
      ["write", "Write"],
    ]).get(tool);
    return value ? [value] : [];
  });
  return mapped.length > 0 ? ["--tools", mapped.join(",")] : [];
}

function piToolArgs(tools: string[]): string[] {
  const mapped = tools.flatMap((tool) => {
    const value = new Map([
      ["bash", "bash"],
      ["edit", "edit"],
      ["glob", "find"],
      ["grep", "grep"],
      ["list", "ls"],
      ["read", "read"],
      ["write", "write"],
    ]).get(tool);
    return value ? [value] : [];
  });
  return mapped.length > 0 ? ["--tools", mapped.join(",")] : [];
}

function skillArgsFor(
  runnerType: RunnerType,
  config: PipelineConfig | undefined,
  actor: ActorConfig | undefined,
  worktreePath: string
): string[] {
  const paths = (actor?.skills ?? []).flatMap((id) => {
    const path = config?.skills[id]?.path;
    return path ? [join(worktreePath, path)] : [];
  });
  if (paths.length === 0) {
    return [];
  }
  if (runnerType === "kimi") {
    return [...new Set(paths.map((path) => dirname(path)))].flatMap((path) => [
      "--skills-dir",
      path,
    ]);
  }
  if (runnerType === "pi") {
    return paths.flatMap((path) => ["--skill", path]);
  }
  return [];
}

function selectedMcpServers(
  config: PipelineConfig | undefined,
  actor: ActorConfig | undefined
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    (actor?.mcp_servers ?? []).flatMap((id) => {
      const server = config?.mcp_servers[id];
      return server ? [[id, server] as const] : [];
    })
  );
}

function mcpArgsFor(
  runnerType: RunnerType,
  config: PipelineConfig | undefined,
  actor: ActorConfig | undefined
): string[] {
  const servers = selectedMcpServers(config, actor);
  if (Object.keys(servers).length === 0) {
    return [];
  }
  if (runnerType === "claude") {
    return [
      "--mcp-config",
      JSON.stringify(toClaudeKimiMcpConfig(servers)),
      "--strict-mcp-config",
    ];
  }
  if (runnerType === "kimi") {
    return ["--mcp-config", JSON.stringify(toClaudeKimiMcpConfig(servers))];
  }
  if (runnerType === "codex") {
    return codexMcpArgs(servers);
  }
  return [];
}

function runnerEnv(
  runnerType: RunnerType,
  config: PipelineConfig,
  actor: ActorConfig | undefined,
  worktreePath: string,
  nodeId: string
): Record<string, string> {
  const servers = selectedMcpServers(config, actor);
  if (runnerType !== "opencode" || Object.keys(servers).length === 0) {
    return {};
  }
  const dir = mkdtempSync(join(tmpdir(), "pipeline-opencode-mcp-"));
  const path = join(dir, `${nodeId}.json`);
  writeFileSync(path, JSON.stringify(toOpenCodeMcpConfig(servers)));
  return {
    OPENCODE_CONFIG: path,
    PIPELINE_WORKTREE: worktreePath,
  };
}

function toClaudeKimiMcpConfig(servers: Record<string, McpServerConfig>): {
  mcpServers: Record<string, McpServerConfig>;
} {
  return { mcpServers: servers };
}

function toOpenCodeMcpConfig(servers: Record<string, McpServerConfig>): {
  mcp: Record<string, Record<string, unknown>>;
} {
  return {
    mcp: Object.fromEntries(
      Object.entries(servers).map(([id, server]) => [
        id,
        {
          command: [server.command, ...(server.args ?? [])],
          enabled: true,
          ...(server.env ? { environment: server.env } : {}),
          type: "local",
        },
      ])
    ),
  };
}

function codexMcpArgs(servers: Record<string, McpServerConfig>): string[] {
  return Object.entries(servers).flatMap(([id, server]) => [
    "--config",
    `mcp_servers.${id}.command=${tomlValue(server.command)}`,
    ...(server.args
      ? ["--config", `mcp_servers.${id}.args=${tomlValue(server.args)}`]
      : []),
    ...(server.env
      ? ["--config", `mcp_servers.${id}.env=${tomlValue(server.env)}`]
      : []),
  ]);
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${key} = ${tomlValue(item)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

function nativeStrategy(
  config: PipelineConfig,
  input: RunnerLaunchInput,
  runnerId: string
): RunnerStrategy {
  const runner = config.runners[runnerId];
  const profile = input.profileId
    ? config.profiles[input.profileId]
    : undefined;
  if (!(runner?.capabilities.native_subagents && profile)) {
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
      stdin: "ignore",
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
