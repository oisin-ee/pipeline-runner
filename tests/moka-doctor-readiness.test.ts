import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET_FILE_NAMES = vi.hoisted(
  () => new Set(["auth.json", "credentials.json", "token"])
);

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

const DEFAULT_TEST_SKILLS = [
  "critique",
  "doubt",
  "execute",
  "fix",
  "inspect",
  "library-first-development",
  "migrate",
  "quick",
  "research",
  "schedule-graph-shaping",
  "scope",
  "secure",
  "spec",
  "test",
  "trace",
  "verify",
];

const MOCK_VISIBLE_MOKA_AGENTS = [
  "MoKa Acceptance Reviewer",
  "MoKa Code Writer",
  "MoKa Researcher",
  "MoKa Test Writer",
  "MoKa Verifier",
];

const SECRET_SENTINEL = "super-secret-token-ticket-10";
const SECRET_ARG_RE = /auth|credential|token/iu;
const ORIGINAL_CI = process.env.CI;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;
const ORIGINAL_FORBID_SECRET_READS =
  process.env.PIPELINE_TEST_FORBID_SECRET_READS;

interface CliCapture {
  stderr: string;
  stdout: string;
  thrown?: unknown;
}

interface DoctorJsonCheck {
  detail?: unknown;
  name?: unknown;
  passed?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

interface DoctorJsonReport {
  blockers?: DoctorJsonCheck[];
  checks?: DoctorJsonCheck[];
  passed?: unknown;
  warnings?: DoctorJsonCheck[];
}

const normalizeReadPath = (path: unknown): string => {
  if (typeof path === "string") {
    return path;
  }
  if (typeof path === "object" && path !== null && "pathname" in path) {
    return decodeURIComponent(String(Reflect.get(path, "pathname")));
  }
  return String(path);
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const readFileSync = vi.fn((path: unknown, ...args: unknown[]) => {
    const pathText = normalizeReadPath(path);
    if (
      process.env.PIPELINE_TEST_FORBID_SECRET_READS === "1" &&
      SECRET_FILE_NAMES.has(pathText.split("/").pop() ?? "")
    ) {
      throw new Error(`doctor must not read secret file: ${pathText}`);
    }
    return actual.readFileSync(path as never, ...(args as never[]));
  });

  return {
    ...actual,
    default: { ...actual, readFileSync },
    readFileSync,
  };
});

const execaResult = async (
  stdout: string
): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> => ({ exitCode: 0, stderr: "", stdout });

const parseDoctorJson = (stdout: string): DoctorJsonReport =>
  JSON.parse(stdout) as DoctorJsonReport;

const findCheck = (report: DoctorJsonReport, name: string): DoctorJsonCheck => {
  const check = report.checks?.find((item) => item.name === name);
  if (!check) {
    throw new Error(`missing doctor check ${name}`);
  }
  return check;
};

const opencodeVersionWasChecked = (): boolean =>
  mockExeca.mock.calls.some(
    ([command, args]) =>
      command === "opencode" &&
      Array.isArray(args) &&
      args.length === 1 &&
      args[0] === "--version"
  );

const opencodeSecretCommands = (): string[][] =>
  mockExeca.mock.calls
    .filter(([command]) => command === "opencode")
    .map(([, args]) => (Array.isArray(args) ? args.map(String) : []))
    .filter((args) => args.some((arg) => SECRET_ARG_RE.test(arg)));

const writeProjectFile = (
  root: string,
  relativePath: string,
  content: string
): void => {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
};

const writeCredentialFiles = (root: string): void => {
  writeProjectFile(
    root,
    ".opencode/auth.json",
    JSON.stringify({ token: SECRET_SENTINEL })
  );
  writeProjectFile(
    root,
    ".config/opencode/auth.json",
    JSON.stringify({ token: SECRET_SENTINEL })
  );
  writeProjectFile(root, ".config/opencode/credentials.json", SECRET_SENTINEL);
  writeProjectFile(root, ".config/opencode/token", SECRET_SENTINEL);
};

const writeHeadlessPermissionRisk = (root: string): void => {
  writeProjectFile(
    root,
    ".opencode/agents/MoKa Test Writer.md",
    [
      "---",
      "name: MoKa Test Writer",
      "mode: all",
      "permission:",
      "  bash: ask",
      "---",
      "",
      "# MoKa Test Writer",
      "",
      "This fixture intentionally requires an interactive permission prompt.",
      "",
    ].join("\n")
  );
};

const writeMockSkills = (root: string): void => {
  const lock: Record<string, unknown> = { skills: {}, version: 1 };
  for (const skill of DEFAULT_TEST_SKILLS) {
    writeProjectFile(
      root,
      join(".agents", "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Mock ${skill} skill.\n---\n\n# ${skill}\n`
    );
    (lock.skills as Record<string, unknown>)[skill] = { source: "mock" };
  }
  writeProjectFile(root, "skills-lock.json", `${JSON.stringify(lock)}\n`);
};

const writeMockAgentRepo = (root: string): void => {
  writeProjectFile(root, "hooks/claude-code/hooks/check.sh", "#!/bin/sh\n");
  writeProjectFile(root, "hooks/codex/hooks/check.sh", "#!/bin/sh\n");
  writeProjectFile(
    root,
    "hooks/opencode/plugin/agent-hooks.ts",
    "export const AgentHooks = async () => ({})\n"
  );
  writeProjectFile(root, "rules/00-test.md", "# Test Rule\n");
};

const writeMockRules = (home: string | void): void => {
  if (home === undefined || home === "") {
    throw new Error("Mock rulesync expected HOME_DIR.");
  }
  writeProjectFile(home, ".claude/CLAUDE.md", "claude rules\n");
  writeProjectFile(home, ".codex/AGENTS.md", "codex rules\n");
  writeProjectFile(home, ".gemini/GEMINI.md", "gemini rules\n");
  writeProjectFile(home, ".config/opencode/AGENTS.md", "opencode rules\n");
};

const defaultDoctorExecaMock = async (
  command: string,
  args: string[] = [],
  options?: { cwd?: string; env?: Record<string, string> }
): Promise<{ exitCode: number; stderr: string; stdout: string }> => {
  if (command === "npx" && args.includes("skills") && args.includes("add")) {
    writeMockSkills(options?.cwd ?? process.cwd());
    return await execaResult("skills installed");
  }
  if (
    command === "npx" &&
    args.includes("rulesync@8.30.1") &&
    args.includes("generate") &&
    !args.includes("--dry-run")
  ) {
    writeMockRules(options?.env?.HOME_DIR);
    return await execaResult("rules generated");
  }
  if (
    command === "gh" &&
    args.slice(0, 3).join(" ") === "repo clone oisin-ee/agent"
  ) {
    writeMockAgentRepo(args[3]);
    return await execaResult("agent cloned");
  }
  if (command === "opencode" && args.join(" ") === "--version") {
    return await execaResult("opencode 1.2.3");
  }
  if (
    command === "opencode" &&
    (args.includes("agent") || args.includes("agents"))
  ) {
    return await execaResult(JSON.stringify(MOCK_VISIBLE_MOKA_AGENTS));
  }
  if (args.join(" ") === "--version") {
    return await execaResult(`${command} 1.0.0`);
  }
  return await execaResult("ok");
};

const restoreEnv = (key: string, value: NodeJS.ProcessEnv[string]): void => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
};

const runCliInTarget = async (
  dir: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<CliCapture> => {
  const { runCli } = await import("../src/index");
  const original = new Map(
    [
      "CI",
      "HOME",
      "PIPELINE_TARGET_PATH",
      "PIPELINE_TEST_FORBID_SECRET_READS",
    ].map((key) => [key, process.env[key]] as const)
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let thrown: unknown;
  try {
    process.env.HOME = dir;
    process.env.PIPELINE_TARGET_PATH = dir;
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }
    await runCli(["node", "/repo/node_modules/.bin/moka", ...args]);
  } catch (error) {
    thrown = error;
  } finally {
    for (const [key, value] of original) {
      restoreEnv(key, value);
    }
  }
  const stdout = log.mock.calls.map(([message]) => String(message)).join("\n");
  const stderr = error.mock.calls
    .map(([message]) => String(message))
    .join("\n");
  log.mockRestore();
  error.mockRestore();
  return { stderr, stdout, thrown };
};

const prepareInitializedProject = async (dir: string): Promise<void> => {
  const init = await runCliInTarget(dir, ["init"]);
  if (init.thrown !== undefined) {
    throw init.thrown;
  }
};

describe("moka doctor run readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockImplementation(defaultDoctorExecaMock as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("CI", ORIGINAL_CI);
    restoreEnv("HOME", ORIGINAL_HOME);
    restoreEnv("PIPELINE_TARGET_PATH", ORIGINAL_PIPELINE_TARGET_PATH);
    restoreEnv(
      "PIPELINE_TEST_FORBID_SECRET_READS",
      ORIGINAL_FORBID_SECRET_READS
    );
  });

  it("doctor --json reports local run readiness and does not fail on warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moka-doctor-ready-json-"));
    try {
      await prepareInitializedProject(dir);
      writeCredentialFiles(dir);
      writeHeadlessPermissionRisk(dir);

      const capture = await runCliInTarget(dir, ["doctor", "--json"], {
        CI: "true",
        PIPELINE_TEST_FORBID_SECRET_READS: "1",
      });

      expect(capture.thrown).toBeUndefined();
      expect(capture.stdout).not.toContain(SECRET_SENTINEL);

      const report = parseDoctorJson(capture.stdout);
      expect(report.passed).toBe(true);
      expect(report.blockers).toEqual([]);
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "headless-permissions" }),
        ])
      );

      expect(findCheck(report, "opencode")).toMatchObject({ passed: true });
      expect(opencodeVersionWasChecked()).toBe(true);
      expect(findCheck(report, "pipeline-config")).toMatchObject({
        passed: true,
      });
      expect(findCheck(report, "opencode-sdk")).toMatchObject({
        passed: true,
      });

      const agentCheck = findCheck(report, "moka-agents");
      expect(agentCheck).toMatchObject({ passed: true });
      expect(JSON.stringify(agentCheck)).toContain("MoKa Test Writer");
      expect(JSON.stringify(agentCheck)).toContain("MoKa Code Writer");

      expect(opencodeSecretCommands()).toEqual([]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("doctor --json separates blockers from headless permission warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moka-doctor-blocker-json-"));
    try {
      await prepareInitializedProject(dir);
      writeHeadlessPermissionRisk(dir);
      mockExeca.mockImplementation((async (
        command: string,
        args?: string[]
      ) => {
        if (command === "opencode" && args?.join(" ") === "--version") {
          throw { shortMessage: "opencode missing" };
        }
        return await defaultDoctorExecaMock(command, args);
      }) as never);

      const capture = await runCliInTarget(dir, ["doctor", "--json"], {
        CI: "true",
      });

      expect(String(capture.thrown)).toContain("Doctor checks failed.");
      const report = parseDoctorJson(capture.stdout);
      expect(report.passed).toBe(false);
      expect(report.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringContaining("opencode missing"),
            name: "opencode",
          }),
        ])
      );
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "headless-permissions" }),
        ])
      );
      expect(report.blockers).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "headless-permissions" }),
        ])
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
