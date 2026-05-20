import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

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

function detectRunner(worktreePath: string): string[] {
  try {
    const pkg = JSON.parse(
      readFileSync(join(worktreePath, "package.json"), "utf-8")
    ) as {
      scripts?: Record<string, string>;
    };
    const testScript = pkg?.scripts?.test ?? "";
    if (testScript.includes("vitest")) {
      return ["bunx", "vitest", "run"];
    }
    if (testScript.includes("jest")) {
      return ["bunx", "jest"];
    }
    if (testScript.includes("bun test")) {
      return ["bun", "test"];
    }
  } catch {
    // fall through to default
  }
  return ["bunx", "vitest", "run"];
}

// ─── runTests ─────────────────────────────────────────────────────────────────

export async function runTests(worktreePath: string): Promise<TestResult> {
  const [cmd, ...args] = detectRunner(worktreePath);
  try {
    const result = await execa(cmd, args, { cwd: worktreePath });
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
  if (!existsSync(join(worktreePath, "tsconfig.json"))) {
    return { exitCode: 0, output: "skipped" };
  }
  try {
    const result = await execa("tsc", ["--noEmit"], { cwd: worktreePath });
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

// ─── runStyleGates ────────────────────────────────────────────────────────────

const SRC_FILE_RE = /\.(ts|tsx|js|jsx)$/;

const STYLE_PATTERNS: Array<{
  regex: RegExp;
  message: (file: string, line: number) => string;
}> = [
  {
    regex: /style=\{\{/,
    message: (file, line) =>
      `inline style (style={{) detected in ${file}:${line}`,
  },
  {
    regex: /console\.log\s*\(/,
    message: (file, line) => `console.log detected in ${file}:${line}`,
  },
  {
    regex: /className="[^"]*\[[^\]]+\][^"]*"/,
    message: (file, line) =>
      `arbitrary Tailwind value detected in ${file}:${line}`,
  },
];

function walkSrcFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSrcFiles(full));
    } else if (SRC_FILE_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export function runStyleGates(worktreePath: string): {
  violations: GateViolation[];
} {
  const files = walkSrcFiles(join(worktreePath, "src"));
  const violations: GateViolation[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      for (const { regex, message } of STYLE_PATTERNS) {
        if (regex.test(lines[i])) {
          violations.push({
            file,
            line: lineNum,
            message: message(file, lineNum),
          });
        }
      }
    }
  }

  return { violations };
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
