import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { Option } from "effect";
import { execa } from "execa";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";

import { parseJson } from "./safe-json";

export interface TestResult {
  command?: string;
  exitCode: number;
  failingTests: string[];
  output: string;
}

export interface GateViolation {
  file: string;
  line?: number;
  message: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FAILING_TEST_RE = /^[✗×✕●]\s+(.+)$/u;

const parseFailingTests = (output: string): string[] =>
  output.split("\n").flatMap((line) => {
    const m = FAILING_TEST_RE.exec(line);
    return m ? [m[1].trim()] : [];
  });

interface ProjectCommand {
  args: string[];
  command: string;
  shell?: boolean;
}

type PackageManagerAgent = Parameters<typeof resolveCommand>[0];

const displayCommand = (command: ProjectCommand): string =>
  [command.command, ...command.args].join(" ");

const optionalLine = (value: Option.Option<string>): Option.Option<string> =>
  Option.match(value, {
    onNone: () => Option.none(),
    onSome: (resolved) =>
      resolved.length === 0 ? Option.none() : Option.some(resolved),
  });

const nonEmptyLines = (values: Option.Option<string>[]): string[] =>
  values.flatMap((value) =>
    Option.match(value, {
      onNone: () => [],
      onSome: (resolved) => [resolved],
    })
  );

const readPackageScripts = (worktreePath: string): Record<string, string> => {
  try {
    const pkg = parseJson(
      readFileSync(join(worktreePath, "package.json"), "utf-8"),
      "package.json"
    ) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
};

const envCommand = (envName: string): Option.Option<ProjectCommand> => {
  const envValue = process.env[envName];
  if (envValue === undefined) {
    return Option.none();
  }
  const raw = envValue.trim();
  if (raw.length === 0) {
    return Option.none();
  }
  return Option.some({ args: [], command: raw, shell: true });
};

const detectPackageManagerAgent = async (
  worktreePath: string
): Promise<PackageManagerAgent> => {
  const pm = await detect({ cwd: worktreePath, stopDir: worktreePath });
  return pm?.agent ?? "npm";
};

const resolvePackageScript = async (
  worktreePath: string,
  scriptName: string
): Promise<Option.Option<ProjectCommand>> => {
  const scripts = readPackageScripts(worktreePath);
  if (!Object.hasOwn(scripts, scriptName)) {
    return Option.none();
  }

  const resolved = resolveCommand(
    await detectPackageManagerAgent(worktreePath),
    "run",
    [scriptName]
  );
  if (resolved === null) {
    return Option.none();
  }
  return Option.some({ args: resolved.args, command: resolved.command });
};

const resolvePackageBinaryCommand = async (
  worktreePath: string,
  binary: string,
  args: string[]
): Promise<Option.Option<ProjectCommand>> => {
  if (!existsSync(join(worktreePath, "package.json"))) {
    return Option.none();
  }

  switch (await detectPackageManagerAgent(worktreePath)) {
    case "bun": {
      return Option.some({ args: ["x", binary, ...args], command: "bun" });
    }
    case "pnpm": {
      return Option.some({ args: ["exec", binary, ...args], command: "pnpm" });
    }
    case "yarn": {
      return Option.some({ args: ["exec", binary, ...args], command: "yarn" });
    }
    case "deno": {
      throw new Error('Not implemented yet: "deno" case');
    }
    case "npm": {
      throw new Error('Not implemented yet: "npm" case');
    }
    case "pnpm@6": {
      throw new Error('Not implemented yet: "pnpm@6" case');
    }
    case "yarn@berry": {
      throw new Error('Not implemented yet: "yarn@berry" case');
    }
    default: {
      return Option.some({ args: ["--yes", binary, ...args], command: "npx" });
    }
  }
};

const commandError = (
  err: unknown
): {
  exitCode?: number;
  message?: string;
  shortMessage?: string;
  stderr?: string;
  stdout?: string;
} =>
  err as {
    exitCode?: number;
    message?: string;
    shortMessage?: string;
    stderr?: string;
    stdout?: string;
  };

const hidePipelineRunsDirectory = (
  worktreePath: string
): Option.Option<{ restore: () => void }> => {
  const pipelineDir = join(worktreePath, ".pipeline");
  const runsDir = join(pipelineDir, "runs");
  if (!existsSync(runsDir)) {
    return Option.none();
  }

  const hiddenRunsDir = join(
    pipelineDir,
    `.runs-hidden-${process.pid}-${Date.now()}`
  );
  renameSync(runsDir, hiddenRunsDir);
  return Option.some({
    restore: () => {
      if (!existsSync(hiddenRunsDir)) {
        return;
      }
      renameSync(hiddenRunsDir, runsDir);
    },
  });
};

const commandErrorOutput = (err: {
  message?: string;
  shortMessage?: string;
  stderr?: string;
  stdout?: string;
}): string =>
  nonEmptyLines([
    optionalLine(Option.fromUndefinedOr(err.stdout)),
    optionalLine(Option.fromUndefinedOr(err.stderr)),
  ]).join("\n") ||
  nonEmptyLines([
    optionalLine(Option.fromUndefinedOr(err.shortMessage)),
    optionalLine(Option.fromUndefinedOr(err.message)),
  ]).join("\n");

const runProjectCommand = async (
  projectCommand: ProjectCommand,
  worktreePath: string,
  signal?: AbortSignal,
  options?: { hidePipelineRuns?: boolean }
): Promise<{ command?: string; exitCode: number; output: string }> => {
  const hiddenRuns =
    options?.hidePipelineRuns === true
      ? hidePipelineRunsDirectory(worktreePath)
      : Option.none();
  try {
    const result = await execa(projectCommand.command, projectCommand.args, {
      cancelSignal: signal,
      cwd: worktreePath,
      shell: projectCommand.shell,
    });
    const output = nonEmptyLines([
      Option.some(result.stdout),
      Option.some(result.stderr),
    ]).join("\n");
    return {
      command: displayCommand(projectCommand),
      exitCode: result.exitCode ?? 0,
      output,
    };
  } catch (error) {
    const e = commandError(error);
    return {
      command: displayCommand(projectCommand),
      exitCode: e.exitCode ?? 1,
      output: commandErrorOutput(e),
    };
  } finally {
    Option.match(hiddenRuns, {
      onNone: () => {},
      onSome: (hidden) => {
        hidden.restore();
      },
    });
  }
};

// ─── runTests ─────────────────────────────────────────────────────────────────

export const runTests = async (
  worktreePath: string,
  signal?: AbortSignal
): Promise<TestResult> => {
  const overrideCommand = envCommand("PIPELINE_TEST_COMMAND");
  const projectCommand = Option.isSome(overrideCommand)
    ? overrideCommand
    : await resolvePackageScript(worktreePath, "test");

  if (Option.isNone(projectCommand)) {
    return {
      exitCode: 1,
      failingTests: [],
      output:
        "No test command found. Set PIPELINE_TEST_COMMAND or define a package test script.",
    };
  }

  const result = await runProjectCommand(
    projectCommand.value,
    worktreePath,
    signal
  );
  return {
    ...result,
    failingTests: result.exitCode === 0 ? [] : parseFailingTests(result.output),
  };
};

// ─── runLint ──────────────────────────────────────────────────────────────────

export const runLint = async (
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ command?: string; exitCode: number; output: string }> => {
  const overrideCommand = envCommand("PIPELINE_LINT_COMMAND");
  const projectCommand = Option.isSome(overrideCommand)
    ? overrideCommand
    : await resolvePackageScript(worktreePath, "lint");

  if (Option.isNone(projectCommand)) {
    return { exitCode: 0, output: "skipped" };
  }
  return await runProjectCommand(projectCommand.value, worktreePath, signal, {
    hidePipelineRuns: true,
  });
};

// ─── runFallow ────────────────────────────────────────────────────────────────

export const runFallow = async (
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ command?: string; exitCode: number; output: string }> => {
  const overrideCommand = envCommand("PIPELINE_FALLOW_COMMAND");
  const scriptCommand = Option.isSome(overrideCommand)
    ? overrideCommand
    : await resolvePackageScript(worktreePath, "fallow");
  const binaryCommand = Option.isSome(scriptCommand)
    ? scriptCommand
    : await resolvePackageBinaryCommand(worktreePath, "fallow", ["audit"]);
  const projectCommand = Option.getOrElse(binaryCommand, () => ({
    args: ["audit"],
    command: "fallow",
  }));

  return await runProjectCommand(projectCommand, worktreePath, signal, {
    hidePipelineRuns: true,
  });
};

// ─── runTypecheck ─────────────────────────────────────────────────────────────

export const runTypecheck = async (
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ command?: string; exitCode: number; output: string }> => {
  const overrideCommand = envCommand("PIPELINE_TYPECHECK_COMMAND");
  const projectCommand = Option.isSome(overrideCommand)
    ? overrideCommand
    : await resolvePackageScript(worktreePath, "typecheck");

  if (Option.isNone(projectCommand)) {
    return { exitCode: 0, output: "skipped" };
  }
  return await runProjectCommand(projectCommand.value, worktreePath, signal);
};

// ─── runSemgrep ──────────────────────────────────────────────────────────────

export const runSemgrep = async (
  worktreePath: string,
  signal?: AbortSignal,
  changedFiles?: Iterable<string>
): Promise<{ command?: string; exitCode: number; output: string }> => {
  const overrideCommand = envCommand("PIPELINE_SEMGREP_COMMAND");
  const targets =
    changedFiles === undefined
      ? undefined
      : [...new Set(changedFiles)].filter((file) =>
          existsSync(join(worktreePath, file))
        );
  if (
    Option.isNone(overrideCommand) &&
    targets !== undefined &&
    targets.length === 0
  ) {
    return {
      command: "uvx semgrep scan --config=p/ci --error",
      exitCode: 0,
      output: "skipped: no changed files to scan",
    };
  }
  const projectCommand = Option.getOrElse(overrideCommand, () => ({
    args: [
      "semgrep",
      "scan",
      "--config=p/ci",
      "--error",
      ...(targets === undefined ? ["."] : ["--", ...targets]),
    ],
    command: "uvx",
  }));

  return await runProjectCommand(projectCommand, worktreePath, signal);
};

// ─── artifactExists ───────────────────────────────────────────────────────────

export const artifactExists = (
  worktreePath: string,
  filename: string
): boolean => existsSync(join(worktreePath, filename));

// ─── runJscpd ─────────────────────────────────────────────────────────────────

interface JscpdDuplicate {
  firstFile?: { name?: string; start?: number };
  secondFile?: { name?: string };
}

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

const parseJscpdOutput = (output: string): { violations: GateViolation[] } => {
  try {
    const data = parseJson(output, "jscpd output") as {
      duplicates?: JscpdDuplicate[];
    };
    const violations: GateViolation[] = (data.duplicates ?? []).map((dup) => ({
      file: dup.firstFile?.name ?? "unknown",
      line: dup.firstFile?.start,
      message: `Duplicate code block detected between ${dup.firstFile?.name} and ${dup.secondFile?.name}`,
    }));
    return { violations };
  } catch {
    return { violations: [] };
  }
};

export const runJscpd = async (
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ violations: GateViolation[] }> => {
  try {
    const result = await execa(
      "bunx",
      [
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
      {
        cancelSignal: signal,
        cwd: worktreePath,
      }
    );
    return parseJscpdOutput(result.stdout);
  } catch (error) {
    const e = error as { stdout?: string };
    return parseJscpdOutput(e.stdout ?? "");
  }
};
