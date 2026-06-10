import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
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

const FAILING_TEST_RE = /^[✗×✕●]\s+(.+)$/;

function parseFailingTests(output: string): string[] {
  return output.split("\n").flatMap((line) => {
    const m = FAILING_TEST_RE.exec(line);
    return m ? [m[1].trim()] : [];
  });
}

interface ProjectCommand {
  args: string[];
  command: string;
  shell?: boolean;
}

type PackageManagerAgent = Parameters<typeof resolveCommand>[0];

function displayCommand(command: ProjectCommand): string {
  return [command.command, ...command.args].join(" ");
}

function readPackageScripts(worktreePath: string): Record<string, string> {
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
}

function envCommand(envName: string): ProjectCommand | null {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return null;
  }
  return { command: raw, args: [], shell: true };
}

async function resolvePackageScript(
  worktreePath: string,
  scriptName: string
): Promise<ProjectCommand | null> {
  const scripts = readPackageScripts(worktreePath);
  if (!scripts[scriptName]) {
    return null;
  }

  const resolved = resolveCommand(
    await detectPackageManagerAgent(worktreePath),
    "run",
    [scriptName]
  );
  if (!resolved) {
    return null;
  }
  return { command: resolved.command, args: resolved.args };
}

async function detectPackageManagerAgent(
  worktreePath: string
): Promise<PackageManagerAgent> {
  const pm = await detect({ cwd: worktreePath, stopDir: worktreePath });
  return (pm?.agent ?? "npm") as PackageManagerAgent;
}

async function resolvePackageBinaryCommand(
  worktreePath: string,
  binary: string,
  args: string[]
): Promise<ProjectCommand | null> {
  if (!existsSync(join(worktreePath, "package.json"))) {
    return null;
  }

  switch (await detectPackageManagerAgent(worktreePath)) {
    case "bun":
      return { command: "bun", args: ["x", binary, ...args] };
    case "pnpm":
      return { command: "pnpm", args: ["exec", binary, ...args] };
    case "yarn":
      return { command: "yarn", args: ["exec", binary, ...args] };
    default:
      return { command: "npx", args: ["--yes", binary, ...args] };
  }
}

// ─── runTests ─────────────────────────────────────────────────────────────────

export async function runTests(
  worktreePath: string,
  signal?: AbortSignal
): Promise<TestResult> {
  const projectCommand =
    envCommand("PIPELINE_TEST_COMMAND") ??
    (await resolvePackageScript(worktreePath, "test"));

  if (!projectCommand) {
    return {
      exitCode: 1,
      failingTests: [],
      output:
        "No test command found. Set PIPELINE_TEST_COMMAND or define a package test script.",
    };
  }

  const result = await runProjectCommand(projectCommand, worktreePath, signal);
  return {
    ...result,
    failingTests: result.exitCode === 0 ? [] : parseFailingTests(result.output),
  };
}

// ─── runTypecheck ─────────────────────────────────────────────────────────────

export async function runTypecheck(
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ command?: string; exitCode: number; output: string }> {
  const projectCommand =
    envCommand("PIPELINE_TYPECHECK_COMMAND") ??
    (await resolvePackageScript(worktreePath, "typecheck"));

  if (!projectCommand) {
    return { exitCode: 0, output: "skipped" };
  }
  return await runProjectCommand(projectCommand, worktreePath, signal);
}

// ─── runLint ──────────────────────────────────────────────────────────────────

export async function runLint(
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ command?: string; exitCode: number; output: string }> {
  const projectCommand =
    envCommand("PIPELINE_LINT_COMMAND") ??
    (await resolvePackageScript(worktreePath, "lint"));

  if (!projectCommand) {
    return { exitCode: 0, output: "skipped" };
  }
  return await runProjectCommand(projectCommand, worktreePath, signal, {
    hidePipelineRuns: true,
  });
}

// ─── runFallow ────────────────────────────────────────────────────────────────

export async function runFallow(
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ command?: string; exitCode: number; output: string }> {
  const projectCommand = envCommand("PIPELINE_FALLOW_COMMAND") ??
    (await resolvePackageScript(worktreePath, "fallow")) ??
    (await resolvePackageBinaryCommand(worktreePath, "fallow", ["audit"])) ?? {
      args: ["audit"],
      command: "fallow",
    };

  return runProjectCommand(projectCommand, worktreePath, signal, {
    hidePipelineRuns: true,
  });
}

async function runProjectCommand(
  projectCommand: ProjectCommand,
  worktreePath: string,
  signal?: AbortSignal,
  options?: { hidePipelineRuns?: boolean }
): Promise<{ command?: string; exitCode: number; output: string }> {
  const hiddenRuns = options?.hidePipelineRuns
    ? hidePipelineRunsDirectory(worktreePath)
    : null;
  try {
    const result = await execa(projectCommand.command, projectCommand.args, {
      cancelSignal: signal,
      cwd: worktreePath,
      shell: projectCommand.shell,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      command: displayCommand(projectCommand),
      exitCode: result.exitCode ?? 0,
      output,
    };
  } catch (err) {
    const e = commandError(err);
    return {
      command: displayCommand(projectCommand),
      exitCode: e.exitCode ?? 1,
      output: commandErrorOutput(e),
    };
  } finally {
    hiddenRuns?.restore();
  }
}

function hidePipelineRunsDirectory(
  worktreePath: string
): { restore: () => void } | null {
  const pipelineDir = join(worktreePath, ".pipeline");
  const runsDir = join(pipelineDir, "runs");
  if (!existsSync(runsDir)) {
    return null;
  }

  const hiddenRunsDir = join(
    pipelineDir,
    `.runs-hidden-${process.pid}-${Date.now()}`
  );
  renameSync(runsDir, hiddenRunsDir);
  return {
    restore: () => {
      if (!existsSync(hiddenRunsDir)) {
        return;
      }
      renameSync(hiddenRunsDir, runsDir);
    },
  };
}

function commandError(err: unknown): {
  exitCode?: number;
  message?: string;
  shortMessage?: string;
  stderr?: string;
  stdout?: string;
} {
  return err as {
    exitCode?: number;
    message?: string;
    shortMessage?: string;
    stderr?: string;
    stdout?: string;
  };
}

function commandErrorOutput(err: {
  message?: string;
  shortMessage?: string;
  stderr?: string;
  stdout?: string;
}): string {
  return (
    [err.stdout, err.stderr].filter(Boolean).join("\n") ||
    [err.shortMessage, err.message].filter(Boolean).join("\n")
  );
}

// ─── runSemgrep ──────────────────────────────────────────────────────────────

export async function runSemgrep(
  worktreePath: string,
  signal?: AbortSignal,
  changedFiles?: Iterable<string>
): Promise<{ command?: string; exitCode: number; output: string }> {
  const overrideCommand = envCommand("PIPELINE_SEMGREP_COMMAND");
  const targets = changedFiles
    ? [...new Set(changedFiles)].filter((file) =>
        existsSync(join(worktreePath, file))
      )
    : undefined;
  if (!overrideCommand && targets && targets.length === 0) {
    return {
      command: "uvx semgrep scan --config=p/ci --error",
      exitCode: 0,
      output: "skipped: no changed files to scan",
    };
  }
  const projectCommand = overrideCommand ?? {
    args: [
      "semgrep",
      "scan",
      "--config=p/ci",
      "--error",
      ...(targets ? ["--", ...targets] : ["."]),
    ],
    command: "uvx",
  };

  return await runProjectCommand(projectCommand, worktreePath, signal);
}

// ─── artifactExists ───────────────────────────────────────────────────────────

export function artifactExists(
  worktreePath: string,
  filename: string
): boolean {
  return existsSync(join(worktreePath, filename));
}

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

function parseJscpdOutput(output: string): { violations: GateViolation[] } {
  try {
    const data = parseJson(output, "jscpd output") as {
      duplicates?: JscpdDuplicate[];
    };
    const violations: GateViolation[] = (data?.duplicates ?? []).map((dup) => ({
      file: dup?.firstFile?.name ?? "unknown",
      line: dup?.firstFile?.start,
      message: `Duplicate code block detected between ${dup?.firstFile?.name} and ${dup?.secondFile?.name}`,
    }));
    return { violations };
  } catch {
    return { violations: [] };
  }
}

export async function runJscpd(
  worktreePath: string,
  signal?: AbortSignal
): Promise<{ violations: GateViolation[] }> {
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
    return parseJscpdOutput(result.stdout ?? "");
  } catch (err) {
    const e = err as { stdout?: string };
    return parseJscpdOutput(e.stdout ?? "");
  }
}
