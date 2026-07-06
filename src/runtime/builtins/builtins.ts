import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { Effect, Option } from "effect";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";

import type { GateViolation } from "../../gates";
import { parseJscpdDuplicateViolations } from "../../jscpd-output";
import type { PlannedWorkflowNode } from "../../planning/compile";
import { acquireRunStateLock } from "../../run-control/run-state-lock";
import { isRecord, parseJson, stringRecord } from "../../safe-json";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { executeDrainMergeBuiltin } from "../drain-merge";
import { executeOpenPullRequestBuiltin } from "../open-pull-request";
import { CommandExecutor, CommandExecutorLive } from "../services/command-executor-service";

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

type BuiltinHandler = (context: RuntimeContext, node?: PlannedWorkflowNode) => BuiltinEffect;

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

const WHITESPACE_RE = /\s/u;

const unsupportedBuiltin = (builtin: string): NodeAttemptResult => ({
  evidence: [`unsupported builtin '${builtin}'`],
  exitCode: 1,
  output: "",
});

const detectPackageManagerAgent = (worktreePath: string): Effect.Effect<PackageManagerAgent, unknown> =>
  Effect.tryPromise(async () => {
    const pm = await detect({ cwd: worktreePath, stopDir: worktreePath });
    return pm?.agent ?? "npm";
  });

const packageManagerCommand = (agent: PackageManagerAgent, args: string[]): Option.Option<ProjectCommand> => {
  const resolved = resolveCommand(agent, "run", args);
  return resolved === null ? Option.none() : Option.some({ args: resolved.args, command: resolved.command });
};

const packageBinaryCommand = (agent: PackageManagerAgent, binary: string, args: string[]): ProjectCommand => {
  const commands: Record<string, ProjectCommand> = {
    bun: { args: ["x", binary, ...args], command: "bun" },
    pnpm: { args: ["exec", binary, ...args], command: "pnpm" },
    yarn: { args: ["exec", binary, ...args], command: "yarn" },
  };
  return (
    commands[agent] ?? {
      args: ["--yes", binary, ...args],
      command: "npx",
    }
  );
};

const resolvePackageBinaryCommand = (
  worktreePath: string,
  binary: string,
  args: string[],
): Effect.Effect<Option.Option<ProjectCommand>, unknown> =>
  Effect.gen(function* effectBody() {
    if (!existsSync(join(worktreePath, "package.json"))) {
      return Option.none();
    }
    return Option.some(packageBinaryCommand(yield* detectPackageManagerAgent(worktreePath), binary, args));
  });

const executableProjectCommand = (command: string): ProjectCommand => ({
  args: [],
  command,
});

const shellProjectCommand = (command: string): ProjectCommand => ({
  args: ["-c", command],
  command: "sh",
  display: command,
});

const envProjectCommand = (raw: string): ProjectCommand =>
  WHITESPACE_RE.test(raw) ? shellProjectCommand(raw) : executableProjectCommand(raw);

const envCommand = (envName: string): Option.Option<ProjectCommand> => {
  const raw = process.env[envName]?.trim();
  return raw === undefined || raw.length === 0 ? Option.none() : Option.some(envProjectCommand(raw));
};

const readPackageJsonText = (worktreePath: string): Option.Option<string> => {
  try {
    return Option.some(readFileSync(join(worktreePath, "package.json"), "utf-8"));
  } catch {
    return Option.none();
  }
};

const packageScriptsFromJson = (text: string): Record<string, string> => {
  const pkg = parseJson(text, "package.json");
  return isRecord(pkg) ? stringRecord(pkg.scripts) : {};
};

const readPackageScripts = (worktreePath: string): Partial<Record<string, string>> => {
  const text = readPackageJsonText(worktreePath);
  return Option.match(text, {
    onNone: () => ({}),
    onSome: packageScriptsFromJson,
  });
};

const resolvePackageScript = (
  worktreePath: string,
  scriptName: string,
): Effect.Effect<Option.Option<ProjectCommand>, unknown> =>
  Effect.gen(function* effectBody() {
    const script = readPackageScripts(worktreePath)[scriptName];
    if (script === undefined || script.length === 0) {
      return Option.none();
    }
    return packageManagerCommand(yield* detectPackageManagerAgent(worktreePath), [scriptName]);
  });

const resolveRequiredScriptCommand = (
  worktreePath: string,
  envName: string,
  scriptName: string,
): Effect.Effect<Option.Option<ProjectCommand>, unknown> =>
  Effect.gen(function* effectBody() {
    const env = envCommand(envName);
    return Option.isSome(env) ? env : yield* resolvePackageScript(worktreePath, scriptName);
  });

const runtimeChangedFiles = (context: RuntimeContext): string[] =>
  [
    ...new Set([...context.nodeStateStore.nodeSnapshots.values()].flatMap((snapshot) => [...snapshot.files])),
  ].toSorted();

const semgrepTargets = (context: RuntimeContext): Option.Option<string[]> => {
  const targets = runtimeChangedFiles(context).filter((file) => existsSync(join(context.worktreePath, file)));
  return targets.length === 0 ? Option.none() : Option.some(targets);
};

const semgrepScanCommand = (targets: Option.Option<string[]>): Option.Option<ProjectCommand> =>
  Option.map(targets, (values) => ({
    args: ["semgrep", "scan", "--config=p/ci", "--error", "--", ...values],
    command: "uvx",
  }));

const resolveSemgrepCommand = (context: RuntimeContext): Effect.Effect<Option.Option<ProjectCommand>> =>
  Effect.sync(() => {
    const override = envCommand("PIPELINE_SEMGREP_COMMAND");
    const targets = semgrepTargets(context);
    return Option.isSome(override) ? override : semgrepScanCommand(targets);
  });

const jscpdCommand = (): ProjectCommand => ({
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
});

const fallowCommand = (): ProjectCommand => ({
  args: ["audit"],
  command: "fallow",
});

const resolveFallowCommand = (worktreePath: string): Effect.Effect<ProjectCommand, unknown> =>
  Effect.gen(function* effectBody() {
    const script = yield* resolvePackageScript(worktreePath, "fallow");
    const binary = yield* resolvePackageBinaryCommand(worktreePath, "fallow", ["audit"]);
    return Option.getOrElse(
      Option.orElse(envCommand("PIPELINE_FALLOW_COMMAND"), () => Option.orElse(script, () => binary)),
      fallowCommand,
    );
  });

const projectCommandArray = (command: ProjectCommand): string[] => [command.command, ...command.args];

const displayCommand = (command: ProjectCommand): string => command.display ?? projectCommandArray(command).join(" ");

const executeVisibleProjectCommand = (
  command: ProjectCommand,
  context: RuntimeContext,
): Effect.Effect<BuiltinCommandResult, unknown, CommandExecutor> =>
  Effect.gen(function* effectBody() {
    const executor = yield* CommandExecutor;
    const result = yield* executor.execute(projectCommandArray(command), context);
    return { command: displayCommand(command), ...result };
  });

const builtinEnvName = (builtin: "lint" | "typecheck"): string => `PIPELINE_${builtin.toUpperCase()}_COMMAND`;

const missingTestCommandResult = (): NodeAttemptResult => ({
  evidence: ["No test command found. Set PIPELINE_TEST_COMMAND or define a package test script."],
  exitCode: 1,
  output: "No test command found. Set PIPELINE_TEST_COMMAND or define a package test script.",
});

const duplicationBuiltinResult = (violations: GateViolation[]): NodeAttemptResult => ({
  evidence: violations.map((violation) => violation.message),
  exitCode: violations.length === 0 ? 0 : 1,
  output: JSON.stringify(violations),
});

const pipelineRunsPaths = (
  worktreePath: string,
): {
  hidden: string;
  runs: string;
} => {
  const pipelineDir = join(worktreePath, ".pipeline");
  return {
    hidden: join(pipelineDir, `.runs-hidden-${process.pid}-${Date.now()}`),
    runs: join(pipelineDir, "runs"),
  };
};

const restoreHiddenRuns = (paths: { hidden: string; runs: string }): void => {
  if (existsSync(paths.hidden)) {
    renameSync(paths.hidden, paths.runs);
  }
};

const hidePipelineRunsDirectory = (
  worktreePath: string,
): Option.Option<{
  restore: () => void;
}> => {
  const paths = pipelineRunsPaths(worktreePath);
  if (!existsSync(paths.runs)) {
    return Option.none();
  }
  renameSync(paths.runs, paths.hidden);
  return Option.some({
    restore: () => {
      restoreHiddenRuns(paths);
    },
  });
};

const withHiddenPipelineRuns = <A, E, R>(
  worktreePath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  // Hold the run-state lock across the entire hide -> command -> restore window
  // so the run-control reporter never persists a node-status event while
  // .pipeline/runs is relocated. The lock is acquired BEFORE hiding and released
  // AFTER restoring, so concurrent run-state persistence simply queues behind
  // this builtin rather than failing on a missing run directory.
  Effect.acquireUseRelease(
    Effect.promise(async () => await acquireRunStateLock()),
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => hidePipelineRunsDirectory(worktreePath)),
        () => effect,
        (hiddenRuns) =>
          Effect.sync(() => {
            if (Option.isSome(hiddenRuns)) {
              hiddenRuns.value.restore();
            }
          }),
      ),
    (release) =>
      Effect.sync(() => {
        release();
      }),
  );

const executeProjectCommand = (
  command: ProjectCommand,
  context: RuntimeContext,
  hidePipelineRuns = false,
): Effect.Effect<BuiltinCommandResult, unknown, CommandExecutor> => {
  const run = executeVisibleProjectCommand(command, context);
  return hidePipelineRuns ? withHiddenPipelineRuns(context.worktreePath, run) : run;
};

const FAILING_TEST_RE = /^[✗×✕●]\s+(.+)$/u;

const parseFailingTestLine = (line: string): string[] => {
  const match = FAILING_TEST_RE.exec(line);
  return match ? [match[1].trim()] : [];
};

const parseFailingTests = (output: string): string[] => output.split("\n").flatMap(parseFailingTestLine);

const executeDuplicationBuiltinEffect = (context: RuntimeContext): BuiltinEffect =>
  Effect.gen(function* effectBody() {
    const command = jscpdCommand();
    const result = yield* executeProjectCommand(command, context);
    return duplicationBuiltinResult(parseJscpdDuplicateViolations(result.output));
  });

const builtinCommandEvidence = (builtin: string, result: BuiltinCommandResult): string[] => {
  const command = result.command === undefined || result.command.length === 0 ? "" : `: ${result.command}`;
  return [
    `builtin '${builtin}' exited ${result.exitCode}${command}`,
    result.output || `builtin '${builtin}' produced no output`,
  ];
};

const skippedBuiltinResult = (builtin: string): NodeAttemptResult => ({
  evidence: builtinCommandEvidence(builtin, {
    exitCode: 0,
    output: "skipped",
  }),
  exitCode: 0,
  output: "skipped",
});

const commandBuiltinResult = (
  builtin: string,
  result: BuiltinCommandResult,
  extraEvidence: string[] = [],
): NodeAttemptResult => ({
  evidence: [...builtinCommandEvidence(builtin, result), ...extraEvidence],
  exitCode: result.exitCode,
  output: result.output,
});

const executeTestBuiltinEffect = (context: RuntimeContext): BuiltinEffect =>
  Effect.gen(function* effectBody() {
    const command = yield* resolveRequiredScriptCommand(context.worktreePath, "PIPELINE_TEST_COMMAND", "test");
    if (Option.isNone(command)) {
      return missingTestCommandResult();
    }
    const result = yield* executeProjectCommand(command.value, context);
    const failingTests = result.exitCode === 0 ? [] : parseFailingTests(result.output);
    return commandBuiltinResult("test", result, failingTests);
  });

const executeScriptCommandBuiltin = (
  builtin: "lint" | "typecheck",
  command: ProjectCommand,
  context: RuntimeContext,
): BuiltinEffect =>
  executeProjectCommand(command, context, builtin === "lint").pipe(
    Effect.map((result) => commandBuiltinResult(builtin, result)),
  );

const executeScriptBuiltinEffect = (context: RuntimeContext, builtin: "lint" | "typecheck"): BuiltinEffect =>
  Effect.gen(function* effectBody() {
    const command = yield* resolveRequiredScriptCommand(context.worktreePath, builtinEnvName(builtin), builtin);
    return Option.isSome(command)
      ? yield* executeScriptCommandBuiltin(builtin, command.value, context)
      : skippedBuiltinResult(builtin);
  });

const executeFallowBuiltinEffect = (context: RuntimeContext): BuiltinEffect =>
  Effect.gen(function* effectBody() {
    const command = yield* resolveFallowCommand(context.worktreePath);
    const result = yield* executeProjectCommand(command, context, true);
    return commandBuiltinResult("fallow", result);
  });

const semgrepNoChangedFilesResult = (): NodeAttemptResult => {
  const result = {
    command: "uvx semgrep scan --config=p/ci --error",
    exitCode: 0,
    output: "skipped: no changed files to scan",
  };
  return commandBuiltinResult("semgrep", result);
};

const executeSemgrepBuiltinEffect = (context: RuntimeContext): BuiltinEffect =>
  Effect.gen(function* effectBody() {
    const command = yield* resolveSemgrepCommand(context);
    if (Option.isNone(command)) {
      return semgrepNoChangedFilesResult();
    }
    const result = yield* executeProjectCommand(command.value, context);
    return commandBuiltinResult("semgrep", result);
  });

const BUILTIN_HANDLERS: Partial<Record<string, BuiltinHandler>> = {
  "drain-merge": (context, node) => Effect.tryPromise(async () => await executeDrainMergeBuiltin(context, node)),
  duplication: (context) => executeDuplicationBuiltinEffect(context),
  fallow: (context) => executeFallowBuiltinEffect(context),
  lint: (context) => executeScriptBuiltinEffect(context, "lint"),
  "open-pull-request": (context, node) =>
    Effect.tryPromise(async () => await executeOpenPullRequestBuiltin(context, node)),
  semgrep: (context) => executeSemgrepBuiltinEffect(context),
  test: (context) => executeTestBuiltinEffect(context),
  typecheck: (context) => executeScriptBuiltinEffect(context, "typecheck"),
};

const executeBuiltinEffect = (builtin: string, context: RuntimeContext, node?: PlannedWorkflowNode): BuiltinEffect => {
  const handler = BUILTIN_HANDLERS[builtin];
  return handler === undefined ? Effect.succeed(unsupportedBuiltin(builtin)) : handler(context, node);
};

export const executeBuiltin = async (
  builtin: string,
  context: RuntimeContext,
  node?: PlannedWorkflowNode,
): Promise<NodeAttemptResult> => {
  const program = executeBuiltinEffect(builtin, context, node);
  return await Effect.runPromise(Effect.provide(program, CommandExecutorLive));
};
