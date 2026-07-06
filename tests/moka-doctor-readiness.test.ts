import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET_FILE_NAMES = vi.hoisted(() => new Set(["auth.json", "credentials.json", "token"]));

interface DoctorExecaOptions {
  cwd?: string;
  env?: Record<string, string>;
}

interface DoctorExecaResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

type DoctorExecaMock = (command: string, args?: string[], options?: DoctorExecaOptions) => Promise<DoctorExecaResult>;

const { mockExeca } = vi.hoisted((): { mockExeca: ReturnType<typeof vi.fn<DoctorExecaMock>> } => ({
  mockExeca: vi.fn<DoctorExecaMock>(),
}));

vi.mock("execa", () => ({
  execa: mockExeca,
}));

import { isRecord, isStringValue, parseJson } from "../src/safe-json";
import { isObjectValue, stringValue, taggedErrorClass } from "../src/schema-boundary";

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
const ORIGINAL_FORBID_SECRET_READS = process.env.PIPELINE_TEST_FORBID_SECRET_READS;

class MokaDoctorReadinessTestError extends taggedErrorClass<MokaDoctorReadinessTestError>()(
  "MokaDoctorReadinessTestError",
  {
    message: stringValue(),
  },
) {}

const mokaDoctorReadinessTestError = (message: string): MokaDoctorReadinessTestError =>
  new MokaDoctorReadinessTestError({ message });

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
}

interface DoctorJsonReport {
  blockers?: DoctorJsonCheck[];
  checks?: DoctorJsonCheck[];
  passed?: unknown;
  warnings?: DoctorJsonCheck[];
}

const hasPathname = (value: unknown): value is { pathname: unknown } => isObjectValue(value) && "pathname" in value;

const normalizeReadPath = (path: unknown): string => {
  if (isStringValue(path)) {
    return path;
  }
  if (hasPathname(path)) {
    return decodeURIComponent(String(Reflect.get(path, "pathname")));
  }
  return String(path);
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const readOriginalFile = actual.readFileSync.bind(actual);
  const readFileSync = vi.fn(
    (path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) => {
      const pathText = normalizeReadPath(path);
      if (
        process.env.PIPELINE_TEST_FORBID_SECRET_READS === "1" &&
        SECRET_FILE_NAMES.has(pathText.split("/").pop() ?? "")
      ) {
        throw mokaDoctorReadinessTestError(`doctor must not read secret file: ${pathText}`);
      }
      return options === undefined ? readOriginalFile(path) : readOriginalFile(path, options);
    },
  );

  return {
    ...actual,
    default: { ...actual, readFileSync },
    readFileSync,
  };
});

const execaResult = async (stdout: string): Promise<DoctorExecaResult> => ({ exitCode: 0, stderr: "", stdout });

const doctorJsonCheck = (value: unknown): DoctorJsonCheck[] => {
  if (!isRecord(value)) {
    return [];
  }
  return [
    {
      detail: value.detail,
      name: value.name,
      passed: value.passed,
      status: value.status,
    },
  ];
};

const doctorJsonChecks = (value: unknown): DoctorJsonCheck[] =>
  Array.isArray(value) ? value.flatMap(doctorJsonCheck) : [];

const parseDoctorJson = (stdout: string): DoctorJsonReport => {
  const value = parseJson(stdout, "doctor JSON output");
  if (!isRecord(value)) {
    throw mokaDoctorReadinessTestError("doctor JSON output must be an object");
  }
  return {
    blockers: doctorJsonChecks(value.blockers),
    checks: doctorJsonChecks(value.checks),
    passed: value.passed,
    warnings: doctorJsonChecks(value.warnings),
  };
};

const findCheck = (report: DoctorJsonReport, name: string): DoctorJsonCheck => {
  const check = report.checks?.find((item) => item.name === name);
  if (!check) {
    throw mokaDoctorReadinessTestError(`missing doctor check ${name}`);
  }
  return check;
};

const opencodeVersionWasChecked = (): boolean =>
  mockExeca.mock.calls.some(
    ([command, args]) => command === "opencode" && Array.isArray(args) && args.length === 1 && args[0] === "--version",
  );

const opencodeSecretCommands = (): string[][] =>
  mockExeca.mock.calls
    .filter(([command]) => command === "opencode")
    .map(([, args]) => (Array.isArray(args) ? args.map(String) : []))
    .filter((args) => args.some((arg) => SECRET_ARG_RE.test(arg)));

const writeProjectFile = async (root: string, relativePath: string, content: string): Promise<void> => {
  const fullPath = join(root, relativePath);
  const fileSystem = await import("node:fs/promises");
  await fileSystem.mkdir(dirname(fullPath), { recursive: true });
  await fileSystem.writeFile(fullPath, content);
};

const makeTempDir = async (prefix: string): Promise<string> => {
  const fileSystem = await import("node:fs/promises");
  return await fileSystem.mkdtemp(join(tmpdir(), prefix));
};

const removePath = async (path: string): Promise<void> => {
  const fileSystem = await import("node:fs/promises");
  await fileSystem.rm(path, { force: true, recursive: true });
};

const writeCredentialFiles = async (root: string): Promise<void> => {
  await Promise.all([
    writeProjectFile(root, ".opencode/auth.json", JSON.stringify({ token: SECRET_SENTINEL })),
    writeProjectFile(root, ".config/opencode/auth.json", JSON.stringify({ token: SECRET_SENTINEL })),
    writeProjectFile(root, ".config/opencode/credentials.json", SECRET_SENTINEL),
    writeProjectFile(root, ".config/opencode/token", SECRET_SENTINEL),
  ]);
};

const writeHeadlessPermissionRisk = async (root: string): Promise<void> => {
  await writeProjectFile(
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
    ].join("\n"),
  );
};

const writeMockSkills = async (root: string): Promise<void> => {
  const skills: Record<string, unknown> = {};
  const lock: { skills: Record<string, unknown>; version: number } = { skills, version: 1 };
  await Promise.all(
    DEFAULT_TEST_SKILLS.map(async (skill) => {
      skills[skill] = { source: "mock" };
      await writeProjectFile(
        root,
        join(".agents", "skills", skill, "SKILL.md"),
        `---\nname: ${skill}\ndescription: Mock ${skill} skill.\n---\n\n# ${skill}\n`,
      );
    }),
  );
  await writeProjectFile(root, "skills-lock.json", `${JSON.stringify(lock)}\n`);
};

const writeMockAgentRepo = async (root: string): Promise<void> => {
  await Promise.all([
    writeProjectFile(root, "hooks/claude-code/hooks/check.sh", "#!/bin/sh\n"),
    writeProjectFile(root, "hooks/codex/hooks/check.sh", "#!/bin/sh\n"),
    writeProjectFile(root, "hooks/opencode/plugin/agent-hooks.ts", "export const AgentHooks = async () => ({})\n"),
    writeProjectFile(root, "rules/00-test.md", "# Test Rule\n"),
  ]);
};

const writeMockRules = async (home: string | void): Promise<void> => {
  if (home === undefined || home === "") {
    throw mokaDoctorReadinessTestError("Mock rulesync expected HOME_DIR.");
  }
  await Promise.all([
    writeProjectFile(home, ".claude/CLAUDE.md", "claude rules\n"),
    writeProjectFile(home, ".codex/AGENTS.md", "codex rules\n"),
    writeProjectFile(home, ".gemini/GEMINI.md", "gemini rules\n"),
    writeProjectFile(home, ".config/opencode/AGENTS.md", "opencode rules\n"),
  ]);
};

const defaultDoctorExecaMock = async (
  command: string,
  args: string[] = [],
  options?: DoctorExecaOptions,
): Promise<DoctorExecaResult> => {
  if (command === "npx" && args.includes("skills") && args.includes("add")) {
    await writeMockSkills(options?.cwd ?? process.cwd());
    return await execaResult("skills installed");
  }
  if (
    command === "npx" &&
    args.includes("rulesync@8.30.1") &&
    args.includes("generate") &&
    !args.includes("--dry-run")
  ) {
    await writeMockRules(options?.env?.HOME_DIR);
    return await execaResult("rules generated");
  }
  if (command === "gh" && args.slice(0, 3).join(" ") === "repo clone oisin-ee/agent") {
    await writeMockAgentRepo(args[3]);
    return await execaResult("agent cloned");
  }
  if (command === "opencode" && args.join(" ") === "--version") {
    return await execaResult("opencode 1.2.3");
  }
  if (command === "opencode" && (args.includes("agent") || args.includes("agents"))) {
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

const runCliInTarget = async (dir: string, args: string[], env: Record<string, string> = {}): Promise<CliCapture> => {
  const { runCli } = await import("../src/index");
  const original = new Map(
    ["CI", "HOME", "PIPELINE_TARGET_PATH", "PIPELINE_TEST_FORBID_SECRET_READS"].map(
      (key) => [key, process.env[key]] as const,
    ),
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
  const stderr = error.mock.calls.map(([message]) => String(message)).join("\n");
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
    mockExeca.mockImplementation(defaultDoctorExecaMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("CI", ORIGINAL_CI);
    restoreEnv("HOME", ORIGINAL_HOME);
    restoreEnv("PIPELINE_TARGET_PATH", ORIGINAL_PIPELINE_TARGET_PATH);
    restoreEnv("PIPELINE_TEST_FORBID_SECRET_READS", ORIGINAL_FORBID_SECRET_READS);
  });

  it("doctor --json reports local run readiness and does not fail on warnings", async () => {
    const dir = await makeTempDir("moka-doctor-ready-json-");
    try {
      await prepareInitializedProject(dir);
      await writeCredentialFiles(dir);
      await writeHeadlessPermissionRisk(dir);

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
        expect.arrayContaining([expect.objectContaining({ name: "headless-permissions" })]),
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
      await removePath(dir);
    }
  });

  it("doctor --json separates blockers from headless permission warnings", async () => {
    const dir = await makeTempDir("moka-doctor-blocker-json-");
    try {
      await prepareInitializedProject(dir);
      await writeHeadlessPermissionRisk(dir);
      const missingOpencodeMock: DoctorExecaMock = async (command, args, options) => {
        if (command === "opencode" && args?.join(" ") === "--version") {
          throw { shortMessage: "opencode missing" };
        }
        return await defaultDoctorExecaMock(command, args, options);
      };
      mockExeca.mockImplementation(missingOpencodeMock);

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
        ]),
      );
      expect(report.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "headless-permissions" })]),
      );
      expect(report.blockers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "headless-permissions" })]),
      );
    } finally {
      await removePath(dir);
    }
  });
});
