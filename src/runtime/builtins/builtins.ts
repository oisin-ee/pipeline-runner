import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";
import type { GateViolation } from "../../gates";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { acquireRunStateLock } from "../../run-control/run-state-lock";
import { parseJson } from "../../safe-json";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { executeDrainMergeBuiltin } from "../drain-merge";
import { executeOpenPullRequestBuiltin } from "../open-pull-request";
import {
  CommandExecutor,
  CommandExecutorLive,
} from "../services/command-executor-service";

interface BuiltinCommandResult {
  command?: string;
  exitCode: number;
  output: string;
}

interface ProjectCommand {
  args: string[];
  command: string;
  display?: string;
}

type PackageManagerAgent = Parameters<typeof resolveCommand>[0];

type BuiltinEffect = Effect.Effect<NodeAttemptResult, unknown, CommandExecutor>;

type BuiltinHandler = (
  context: RuntimeContext,
  node?: PlannedWorkflowNode
) => BuiltinEffect;

const JSCPD_DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/.serena/**",
  "**/.opencode/**",
  "**/.pipeline/host-resources/**",
  "**/.pipeline/skills/**",
  "**/.agents/skills/**",
];

const WHITESPACE_RE = /\s/;

const BUILTIN_HANDLERS: Record<string, BuiltinHandler> = {
  "drain-merge": (context, node) =>
    Effect.tryPromise(() => executeDrainMergeBuiltin(context, node)),
  "open-pull-request": (context, node) =>
    Effect.tryPromise(() => executeOpenPullRequestBuiltin(context, node)),
  duplication: (context) => executeDuplicationBuiltinEffect(context),
  fallow: (context) => executeFallowBuiltinEffect(context),
  lint: (context) => executeScriptBuiltinEffect(context, "lint"),
  semgrep: (context) => executeSemgrepBuiltinEffect(context),
  test: (context) => executeTestBuiltinEffect(context),
  typecheck: (context) => executeScriptBuiltinEffect(context, "typecheck"),
};

export function executeBuiltin(
  builtin: string,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Promise<NodeAttemptResult> {
  const program = executeBuiltinEffect(builtin, context, node);
  return Effect.runPromise(Effect.provide(program, CommandExecutorLive));
}

function executeBuiltinEffect(
  builtin: string,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): BuiltinEffect {
  const handler = BUILTIN_HANDLERS[builtin];
  return handler
    ? handler(context, node)
    : Effect.succeed(unsupportedBuiltin(builtin));
}

function unsupportedBuiltin(builtin: string): NodeAttemptResult {
  return {
    evidence: [`unsupported builtin '${builtin}'`],
    exitCode: 1,
    output: "",
  };
}

function executeTestBuiltinEffect(context: RuntimeContext): BuiltinEffect {
  return Effect.gen(function* () {
    const command = yield* resolveRequiredScriptCommand(
      context.worktreePath,
      "PIPELINE_TEST_COMMAND",
      "test"
    );
    if (!command) {
      return missingTestCommandResult();
    }
    const result = yield* executeProjectCommand(command, context);
    const failingTests =
      result.exitCode === 0 ? [] : parseFailingTests(result.output);
    return commandBuiltinResult("test", result, failingTests);
  });
}

function executeScriptBuiltinEffect(
  context: RuntimeContext,
  builtin: "lint" | "typecheck"
): BuiltinEffect {
  return Effect.gen(function* () {
    const command = yield* resolveRequiredScriptCommand(
      context.worktreePath,
      builtinEnvName(builtin),
      builtin
    );
    return command
      ? yield* executeScriptCommandBuiltin(builtin, command, context)
      : skippedBuiltinResult(builtin);
  });
}

function executeScriptCommandBuiltin(
  builtin: "lint" | "typecheck",
  command: ProjectCommand,
  context: RuntimeContext
): BuiltinEffect {
  return executeProjectCommand(command, context, builtin === "lint").pipe(
    Effect.map((result) => commandBuiltinResult(builtin, result))
  );
}

function executeFallowBuiltinEffect(context: RuntimeContext): BuiltinEffect {
  return Effect.gen(function* () {
    const command = yield* resolveFallowCommand(context.worktreePath);
    const result = yield* executeProjectCommand(command, context, true);
    return commandBuiltinResult("fallow", result);
  });
}

function executeSemgrepBuiltinEffect(context: RuntimeContext): BuiltinEffect {
  return Effect.gen(function* () {
    const command = yield* resolveSemgrepCommand(context);
    if (!command) {
      return semgrepNoChangedFilesResult();
    }
    const result = yield* executeProjectCommand(command, context);
    return commandBuiltinResult("semgrep", result);
  });
}

function executeDuplicationBuiltinEffect(
  context: RuntimeContext
): BuiltinEffect {
  return Effect.gen(function* () {
    const command = jscpdCommand();
    const result = yield* executeProjectCommand(command, context);
    return duplicationBuiltinResult(parseJscpdOutput(result.output));
  });
}

function executeProjectCommand(
  command: ProjectCommand,
  context: RuntimeContext,
  hidePipelineRuns = false
): Effect.Effect<BuiltinCommandResult, unknown, CommandExecutor> {
  const run = executeVisibleProjectCommand(command, context);
  return hidePipelineRuns
    ? withHiddenPipelineRuns(context.worktreePath, run)
    : run;
}

function executeVisibleProjectCommand(
  command: ProjectCommand,
  context: RuntimeContext
): Effect.Effect<BuiltinCommandResult, unknown, CommandExecutor> {
  return Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    const result = yield* executor.execute(
      projectCommandArray(command),
      context
    );
    return { command: displayCommand(command), ...result };
  });
}

function withHiddenPipelineRuns<A, E, R>(
  worktreePath: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  // Hold the run-state lock across the entire hide -> command -> restore window
  // so the run-control reporter never persists a node-status event while
  // .pipeline/runs is relocated. The lock is acquired BEFORE hiding and released
  // AFTER restoring, so concurrent run-state persistence simply queues behind
  // this builtin rather than failing on a missing run directory.
  return Effect.acquireUseRelease(
    Effect.promise(() => acquireRunStateLock()),
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => hidePipelineRunsDirectory(worktreePath)),
        () => effect,
        (hiddenRuns) => Effect.sync(() => hiddenRuns?.restore())
      ),
    (release) => Effect.sync(() => release())
  );
}

function resolveRequiredScriptCommand(
  worktreePath: string,
  envName: string,
  scriptName: string
): Effect.Effect<ProjectCommand | null, unknown> {
  return Effect.gen(function* () {
    const env = envCommand(envName);
    return env ?? (yield* resolvePackageScript(worktreePath, scriptName));
  });
}

function resolveFallowCommand(
  worktreePath: string
): Effect.Effect<ProjectCommand, unknown> {
  return Effect.gen(function* () {
    const script = yield* resolvePackageScript(worktreePath, "fallow");
    const binary = yield* resolvePackageBinaryCommand(worktreePath, "fallow", [
      "audit",
    ]);
    return (
      envCommand("PIPELINE_FALLOW_COMMAND") ??
      script ??
      binary ??
      fallowCommand()
    );
  });
}

function resolveSemgrepCommand(
  context: RuntimeContext
): Effect.Effect<ProjectCommand | null> {
  return Effect.sync(() => {
    const override = envCommand("PIPELINE_SEMGREP_COMMAND");
    const targets = semgrepTargets(context);
    return override ?? semgrepScanCommand(targets);
  });
}

function resolvePackageScript(
  worktreePath: string,
  scriptName: string
): Effect.Effect<ProjectCommand | null, unknown> {
  return Effect.gen(function* () {
    if (!readPackageScripts(worktreePath)[scriptName]) {
      return null;
    }
    return packageManagerCommand(
      yield* detectPackageManagerAgent(worktreePath),
      [scriptName]
    );
  });
}

function resolvePackageBinaryCommand(
  worktreePath: string,
  binary: string,
  args: string[]
): Effect.Effect<ProjectCommand | null, unknown> {
  return Effect.gen(function* () {
    if (!existsSync(join(worktreePath, "package.json"))) {
      return null;
    }
    return packageBinaryCommand(
      yield* detectPackageManagerAgent(worktreePath),
      binary,
      args
    );
  });
}

function detectPackageManagerAgent(
  worktreePath: string
): Effect.Effect<PackageManagerAgent, unknown> {
  return Effect.tryPromise(async () => {
    const pm = await detect({ cwd: worktreePath, stopDir: worktreePath });
    return (pm?.agent ?? "npm") as PackageManagerAgent;
  });
}

function packageManagerCommand(
  agent: PackageManagerAgent,
  args: string[]
): ProjectCommand | null {
  const resolved = resolveCommand(agent, "run", args);
  return resolved ? { args: resolved.args, command: resolved.command } : null;
}

function packageBinaryCommand(
  agent: PackageManagerAgent,
  binary: string,
  args: string[]
): ProjectCommand {
  const commands: Record<string, ProjectCommand> = {
    bun: { args: ["x", binary, ...args], command: "bun" },
    pnpm: { args: ["exec", binary, ...args], command: "pnpm" },
    yarn: { args: ["exec", binary, ...args], command: "yarn" },
  };
  return (
    commands[String(agent)] ?? {
      args: ["--yes", binary, ...args],
      command: "npx",
    }
  );
}

function envCommand(envName: string): ProjectCommand | null {
  const raw = process.env[envName]?.trim();
  return raw ? envProjectCommand(raw) : null;
}

function envProjectCommand(raw: string): ProjectCommand {
  return WHITESPACE_RE.test(raw)
    ? shellProjectCommand(raw)
    : executableProjectCommand(raw);
}

function executableProjectCommand(command: string): ProjectCommand {
  return { args: [], command };
}

function shellProjectCommand(command: string): ProjectCommand {
  return { args: ["-c", command], command: "sh", display: command };
}

function readPackageScripts(worktreePath: string): Record<string, string> {
  const text = readPackageJsonText(worktreePath);
  return text ? packageScriptsFromJson(text) : {};
}

function readPackageJsonText(worktreePath: string): string | null {
  try {
    return readFileSync(join(worktreePath, "package.json"), "utf-8");
  } catch {
    return null;
  }
}

function packageScriptsFromJson(text: string): Record<string, string> {
  const pkg = parseJson(text, "package.json") as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

function runtimeChangedFiles(context: RuntimeContext): string[] {
  return [...new Set(context.nodeStateStore.changedFilesForAllNodes())].sort();
}

function semgrepTargets(context: RuntimeContext): string[] | undefined {
  const targets = runtimeChangedFiles(context).filter((file) =>
    existsSync(join(context.worktreePath, file))
  );
  return targets.length === 0 ? undefined : targets;
}

function semgrepScanCommand(targets?: string[]): ProjectCommand | null {
  if (!targets) {
    return null;
  }
  return {
    args: ["semgrep", "scan", "--config=p/ci", "--error", "--", ...targets],
    command: "uvx",
  };
}

function jscpdCommand(): ProjectCommand {
  return {
    args: [
      "jscpd",
      "--min-tokens",
      "50",
      "--reporters",
      "json",
      "--gitignore",
      "--ignore",
      JSCPD_DEFAULT_IGNORES.join(","),
      ".",
    ],
    command: "bunx",
  };
}

function fallowCommand(): ProjectCommand {
  return { args: ["audit"], command: "fallow" };
}

function projectCommandArray(command: ProjectCommand): string[] {
  return [command.command, ...command.args];
}

function displayCommand(command: ProjectCommand): string {
  return command.display ?? projectCommandArray(command).join(" ");
}

function builtinEnvName(builtin: "lint" | "typecheck"): string {
  return `PIPELINE_${builtin.toUpperCase()}_COMMAND`;
}

function missingTestCommandResult(): NodeAttemptResult {
  return {
    evidence: [
      "No test command found. Set PIPELINE_TEST_COMMAND or define a package test script.",
    ],
    exitCode: 1,
    output:
      "No test command found. Set PIPELINE_TEST_COMMAND or define a package test script.",
  };
}

function skippedBuiltinResult(builtin: string): NodeAttemptResult {
  return {
    evidence: builtinCommandEvidence(builtin, {
      exitCode: 0,
      output: "skipped",
    }),
    exitCode: 0,
    output: "skipped",
  };
}

function semgrepNoChangedFilesResult(): NodeAttemptResult {
  const result = {
    command: "uvx semgrep scan --config=p/ci --error",
    exitCode: 0,
    output: "skipped: no changed files to scan",
  };
  return commandBuiltinResult("semgrep", result);
}

function duplicationBuiltinResult(
  violations: GateViolation[]
): NodeAttemptResult {
  return {
    evidence: violations.map((violation) => violation.message),
    exitCode: violations.length === 0 ? 0 : 1,
    output: JSON.stringify(violations),
  };
}

function commandBuiltinResult(
  builtin: string,
  result: BuiltinCommandResult,
  extraEvidence: string[] = []
): NodeAttemptResult {
  return {
    evidence: [...builtinCommandEvidence(builtin, result), ...extraEvidence],
    exitCode: result.exitCode,
    output: result.output,
  };
}

function hidePipelineRunsDirectory(
  worktreePath: string
): { restore: () => void } | null {
  const paths = pipelineRunsPaths(worktreePath);
  if (!existsSync(paths.runs)) {
    return null;
  }
  renameSync(paths.runs, paths.hidden);
  return {
    restore: () => restoreHiddenRuns(paths),
  };
}

function pipelineRunsPaths(worktreePath: string): {
  hidden: string;
  runs: string;
} {
  const pipelineDir = join(worktreePath, ".pipeline");
  return {
    hidden: join(pipelineDir, `.runs-hidden-${process.pid}-${Date.now()}`),
    runs: join(pipelineDir, "runs"),
  };
}

function restoreHiddenRuns(paths: { hidden: string; runs: string }): void {
  if (existsSync(paths.hidden)) {
    renameSync(paths.hidden, paths.runs);
  }
}

const FAILING_TEST_RE = /^[✗×✕●]\s+(.+)$/;

function parseFailingTests(output: string): string[] {
  return output.split("\n").flatMap(parseFailingTestLine);
}

function parseFailingTestLine(line: string): string[] {
  const match = FAILING_TEST_RE.exec(line);
  return match ? [match[1].trim()] : [];
}

interface JscpdDuplicate {
  firstFile?: { name?: string; start?: number };
  secondFile?: { name?: string };
}

function parseJscpdOutput(output: string): GateViolation[] {
  try {
    const data = parseJson(output, "jscpd output") as {
      duplicates?: JscpdDuplicate[];
    };
    return (data.duplicates ?? []).map(jscpdDuplicateViolation);
  } catch {
    return [];
  }
}

function jscpdDuplicateViolation(dup: JscpdDuplicate): GateViolation {
  const firstFile = jscpdFirstFileName(dup);
  return {
    file: firstFile ?? "unknown",
    line: jscpdFirstFileStart(dup),
    message: `Duplicate code block detected between ${firstFile} and ${jscpdSecondFileName(dup)}`,
  };
}

function jscpdFirstFileName(dup: JscpdDuplicate): string | undefined {
  return dup.firstFile?.name;
}

function jscpdFirstFileStart(dup: JscpdDuplicate): number | undefined {
  return dup.firstFile?.start;
}

function jscpdSecondFileName(dup: JscpdDuplicate): string | undefined {
  return dup.secondFile?.name;
}

function builtinCommandEvidence(
  builtin: string,
  result: BuiltinCommandResult
): string[] {
  const command = result.command ? `: ${result.command}` : "";
  return [
    `builtin '${builtin}' exited ${result.exitCode}${command}`,
    result.output || `builtin '${builtin}' produced no output`,
  ];
}
