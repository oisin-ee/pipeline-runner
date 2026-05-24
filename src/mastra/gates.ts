import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { resolveCommand } from "package-manager-detector/commands";
import { detect } from "package-manager-detector/detect";

export interface TestResult {
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

function readPackageScripts(worktreePath: string): Record<string, string> {
  try {
    const pkg = JSON.parse(
      readFileSync(join(worktreePath, "package.json"), "utf-8")
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

  const pm = await detect({ cwd: worktreePath, stopDir: worktreePath });
  const resolved = resolveCommand(pm?.agent ?? "npm", "run", [scriptName]);
  if (!resolved) {
    return null;
  }
  return { command: resolved.command, args: resolved.args };
}

// ─── runTests ─────────────────────────────────────────────────────────────────

export async function runTests(worktreePath: string): Promise<TestResult> {
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

  try {
    const result = await execa(projectCommand.command, projectCommand.args, {
      cwd: worktreePath,
      shell: projectCommand.shell,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return { exitCode: result.exitCode ?? 0, output, failingTests: [] };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; exitCode?: number };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return {
      exitCode: e.exitCode ?? 1,
      output,
      failingTests: parseFailingTests(output),
    };
  }
}

// ─── runTypecheck ─────────────────────────────────────────────────────────────

export async function runTypecheck(
  worktreePath: string
): Promise<{ exitCode: number; output: string }> {
  const projectCommand =
    envCommand("PIPELINE_TYPECHECK_COMMAND") ??
    (await resolvePackageScript(worktreePath, "typecheck"));

  if (!projectCommand) {
    return { exitCode: 0, output: "skipped" };
  }
  try {
    const result = await execa(projectCommand.command, projectCommand.args, {
      cwd: worktreePath,
      shell: projectCommand.shell,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return { exitCode: result.exitCode ?? 0, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; exitCode?: number };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return { exitCode: e.exitCode ?? 1, output };
  }
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

function parseJscpdOutput(output: string): { violations: GateViolation[] } {
  try {
    const data = JSON.parse(output) as { duplicates?: JscpdDuplicate[] };
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
  worktreePath: string
): Promise<{ violations: GateViolation[] }> {
  try {
    const result = await execa(
      "bunx",
      ["jscpd", "--min-tokens", "50", "--reporters", "json", "."],
      {
        cwd: worktreePath,
      }
    );
    return parseJscpdOutput(result.stdout ?? "");
  } catch (err) {
    const e = err as { stdout?: string };
    return parseJscpdOutput(e.stdout ?? "");
  }
}
