import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";

const mockExeca = vi.mocked(execa);
const DESCRIPTION_RE = /description/i;
const FAILURE_DETAILS_RE =
  /verify: missing artifact[\s\S]*agent boundary node=verify[\s\S]*raw verifier output/;
const PACKAGE_INSPECT_COMMAND_RE = /inspect\s+Read-only repository inspection/;
const PACKAGE_EPIC_COMMAND_RE =
  /epic\s+Route an epic's tickets into specialist/;
const PIPELINE_YAML_SOURCE_RE = /from pipeline\.yaml/i;
const UNKNOWN_ENTRYPOINT_OR_CONFIG_RE =
  /Unknown pipeline entrypoint 'epic'|PIPELINE_CONFIG|Invalid pipeline config|Invalid workflow plan|missing workflow/i;
const PLAN_RESEARCH_RE = /- research kind=agent needs=none/;
const PLAN_PLAN_RE = /- plan kind=agent needs=research/;
const PLAN_IMPLEMENT_RE = /- implement kind=workflow needs=plan/;
const PLAN_MERGE_RE = /- merge kind=builtin needs=implement/;
const PLAN_REVIEW_RE = /- review kind=agent needs=merge/;
const SCHEDULE_MEMORY_ID_RE = /Schedule generated: memory:run-\d{14}/;
const SCHEDULE_RUN_WORKFLOW_RE = /Workflow: schedule-run-\d{14}-root/;
const WARNING_RE = /warning/i;
const NO_REPO_COPY_RE = /clone|copy|mirror/i;
const MISSING_TOOLHIVE_WORKLOAD_RE = /missing ToolHive workload/;
const ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION =
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
const ORIGINAL_PIPELINE_TEST_COMMAND = process.env.PIPELINE_TEST_COMMAND;
const DEFAULT_TEST_SKILLS = [
  "critique",
  "diagnose",
  "doubt",
  "execute",
  "fix",
  "grill",
  "improve",
  "library-first-development",
  "migrate",
  "optimize",
  "quality-gate",
  "research",
  "scope",
  "secure",
  "spec",
  "test",
  "trace",
  "verify",
];

interface MockAgentResponse {
  matches: (prompt: string) => boolean;
  response: unknown;
}

const MOCK_AGENT_RESPONSES: MockAgentResponse[] = [
  {
    matches: (prompt) =>
      prompt.includes("pipeline-acceptance-reviewer") ||
      prompt.includes("acceptance reviewer"),
    response: {
      verdict: "PASS",
      evidence: ["acceptance passed"],
      acceptance: [{ id: "1", verdict: "PASS", evidence: ["accepted"] }],
      violations: [],
    },
  },
  {
    matches: (prompt) =>
      prompt.includes("pipeline-verifier") || prompt.includes("verifier"),
    response: {
      verdict: "PASS",
      evidence: ["verified by CLI fixture"],
    },
  },
  {
    matches: (prompt) =>
      prompt.includes("pipeline-learner") || prompt.includes("LEARN phase"),
    response: {
      qdrant: { attempted: true, succeeded: true },
      evidence: ["stored lesson"],
    },
  },
  {
    matches: (prompt) => prompt.includes("pipeline-researcher"),
    response: {
      ac: ["package OpenCode schedule completes"],
      findings: ["researched package schedule"],
      risks: [],
    },
  },
];

const DEFAULT_MOCK_AGENT_RESPONSE = {
  changes: [
    {
      files: ["src/app.ts"],
      summary: "Implemented CLI fixture task",
      why: "The OpenCode-first schedule agent must report changes",
    },
  ],
  verification: ["CLI fixture verified"],
};

function mockAgentStdout(command: string, args?: string[]): string {
  if (command !== "codex" && command !== "opencode") {
    return "";
  }
  const prompt = Array.isArray(args) ? args.join("\n") : "";
  return JSON.stringify(
    MOCK_AGENT_RESPONSES.find(({ matches }) => matches(prompt))?.response ??
      DEFAULT_MOCK_AGENT_RESPONSE
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

type ConsoleSpy = ReturnType<typeof vi.spyOn>;
type RunCli = typeof import("../src/index")["runCli"];

interface CliTargetFixture {
  error: ConsoleSpy;
  log: ConsoleSpy;
  output: () => string;
  runCli: RunCli;
  stderr: () => string;
}

interface CliTempFixture extends CliTargetFixture {
  dir: string;
}

interface CliOutputCapture {
  failureText?: string;
  stderr: string;
  stdout: string;
  thrown?: unknown;
}

function spyOutput(spy: ConsoleSpy): string {
  return spy.mock.calls.map(([message]) => String(message)).join("\n");
}

async function withCliTarget(
  targetPath: string,
  run: (fixture: CliTargetFixture) => Promise<void>
): Promise<void> {
  const { runCli } = await import("../src/index");
  const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    process.env.PIPELINE_TARGET_PATH = targetPath;
    await run({
      error,
      log,
      output: () => spyOutput(log),
      runCli,
      stderr: () => spyOutput(error),
    });
  } finally {
    log.mockRestore();
    error.mockRestore();
    restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
  }
}

async function withCliTempDir(
  prefix: string,
  run: (fixture: CliTempFixture) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    await withCliTarget(dir, (fixture) => run({ ...fixture, dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function prepareGatewayWorkspace(
  runCli: RunCli,
  dir: string,
  options: { init?: boolean } = {}
): Promise<void> {
  if (options.init) {
    await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
  }
  mkdirSync(join(dir, ".serena"), { recursive: true });
  writeFileSync(join(dir, ".serena/project.yml"), "name: test\n");
  mkdirSync(join(dir, "backlog"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
}

async function runPackageWorkflowCommand(
  fixture: CliTargetFixture,
  command: "explain-plan" | "validate"
): Promise<CliOutputCapture> {
  let thrown: unknown;
  try {
    await fixture.runCli([
      "node",
      "/repo/node_modules/.bin/pipe",
      command,
      "--workflow",
      "epic-drain",
    ]);
  } catch (err) {
    thrown = err;
  }
  const stderr = fixture.stderr();
  const stdout = fixture.output();
  return {
    failureText: [
      thrown instanceof Error ? thrown.message : String(thrown ?? ""),
      stderr,
      stdout,
    ].join("\n"),
    stderr,
    stdout,
    thrown,
  };
}

async function validateCliLintFixture(
  fixture: CliTempFixture,
  parts: Parameters<typeof writeCliValidateLintConfig>[1]
): Promise<CliOutputCapture> {
  writeCliValidateLintConfig(fixture.dir, parts);
  await fixture.runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);
  return {
    stderr: fixture.stderr(),
    stdout: fixture.output(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-basic-payload";
  mockExeca.mockImplementation(((
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ) => {
    if (options?.env?.PIPELINE_HOOK_RESULT) {
      writeFileSync(
        options.env.PIPELINE_HOOK_RESULT,
        JSON.stringify({ status: "pass", summary: command })
      );
    }
    if (
      command === "npx" &&
      Array.isArray(args) &&
      args.includes("skills") &&
      args.includes("add")
    ) {
      installMockSkills(args, (options as { cwd?: string } | undefined)?.cwd);
    }
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: mockAgentStdout(command, args),
    }) as any;
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION === undefined) {
    delete process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
  } else {
    process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION =
      ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION;
  }
  restoreEnv("PIPELINE_TEST_COMMAND", ORIGINAL_PIPELINE_TEST_COMMAND);
});

function installMockSkills(args: string[], cwd = process.cwd()): void {
  const skillIndex = args.indexOf("--skill");
  if (skillIndex < 0) {
    return;
  }
  const requestedSkills = args
    .slice(skillIndex + 1)
    .filter((arg) => !arg.startsWith("-"));
  const skills = requestedSkills.includes("*")
    ? DEFAULT_TEST_SKILLS
    : requestedSkills;
  const lock: Record<string, unknown> = { skills: {}, version: 1 };
  for (const skill of skills) {
    const path = join(cwd, ".agents", "skills", skill, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${skill}\n---\n\n# ${skill}\n`);
    (lock.skills as Record<string, unknown>)[skill] = { source: "mock" };
  }
  writeFileSync(join(cwd, "skills-lock.json"), `${JSON.stringify(lock)}\n`);
}

function writeCliProjectFile(
  root: string,
  path: string,
  content: string
): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function writeCliEntrypointConfig(root: string): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
    ".pipeline/profiles.yaml": `
version: 1
profiles:
  orchestrator:
    runner: local
    instructions: { inline: Orchestrate }
`,
    ".pipeline/pipeline.yaml": `
version: 1
default_workflow: default
entrypoints:
  quick:
    workflow: quick
    description: Quick custom workflow
  inspect:
    workflow: inspect
    description: Inspect custom workflow
  validate:
    workflow: validate-entrypoint
    description: Validate entrypoint workflow
orchestrator:
  profile: orchestrator
hooks:
  functions:
    default-start:
      kind: command
      command: [default-start-bin]
      trusted: true
    quick-start:
      kind: command
      command: [quick-start-bin]
      trusted: true
    validate-start:
      kind: command
      command: [validate-start-bin]
      trusted: true
  on:
    workflow.start:
      - id: default-start
        function: default-start
        where: { workflow: default }
        failure: fail
      - id: quick-start
        function: quick-start
        where: { workflow: quick }
        failure: fail
      - id: validate-start
        function: validate-start
        where: { workflow: validate-entrypoint }
        failure: fail
workflows:
  default:
    nodes:
      - id: default-node
        kind: command
        command: [default-node-bin]
  quick:
    description: Quick custom workflow
    nodes:
      - id: quick-node
        kind: command
        command: [quick-node-bin]
  inspect:
    description: Inspect custom workflow
    nodes:
      - id: inspect-node
        kind: command
        command: [inspect-node-bin]
  validate-entrypoint:
    description: Validate entrypoint workflow
    nodes:
      - id: validate-node
        kind: command
        command: [validate-entrypoint-bin]
`,
  });
}

function writeScheduledCliConfig(root: string): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: scheduled-runner
    capabilities:
      native_subagents: false
      output_formats: [text]
  opencode:
    type: opencode
    command: opencode
    model: openai/gpt-5.4-mini
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json]
`,
    ".pipeline/profiles.yaml": `
version: 1
profiles:
  orchestrator:
    runner: local
    instructions: { inline: Orchestrate }
  pipeline-researcher:
    runner: local
    instructions: { inline: Research }
  pipeline-code-writer:
    runner: local
    instructions: { inline: Implement }
  pipeline-opencode-code-writer:
    runner: opencode
    model: openai/gpt-5.4-mini
    instructions: { inline: Implement with OpenCode }
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem: { mode: workspace-write }
    network: { mode: inherit }
  pipeline-verifier:
    runner: local
    instructions: { inline: Verify }
  pipeline-learner:
    runner: local
    instructions: { inline: Learn }
  pipeline-thermo-nuclear-reviewer:
    runner: local
    instructions: { inline: Review }
  pipeline-schedule-planner:
    runner: local
    instructions: { inline: Plan schedule }
`,
    ".pipeline/pipeline.yaml": `
version: 1
default_workflow: inspect
entrypoints:
  pipe:
    schedule: pipe-schedule
    description: Generated pipe schedule
  inspect:
    workflow: inspect
    description: Inspect static workflow
orchestrator:
  profile: orchestrator
schedules:
  pipe-schedule:
    baseline: pipe
    planner_profile: pipeline-schedule-planner
workflows:
  inspect:
    nodes:
      - id: inspect
        kind: command
        command: [inspect-bin]
`,
  });
}

function writeMalformedCliConfig(root: string): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
    ".pipeline/profiles.yaml": `
version: 1
profiles:
  orchestrator:
    runner: local
    instructions: { inline: Orchestrate }
`,
    ".pipeline/pipeline.yaml": "version: [\n",
  });
}

function writeCliValidateLintConfig(
  root: string,
  options: {
    pipeline?: string;
    profiles?: string;
  } = {}
): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text, json_schema]
      skills: true
`,
    ".pipeline/profiles.yaml":
      options.profiles ??
      `
version: 1
skills:
  present:
    path: .agents/skills/present/SKILL.md
profiles:
  orchestrator:
    runner: local
    instructions:
      path: .pipeline/prompts/orchestrator.md
    skills: [present]
    output:
      format: json_schema
      schema_path: .pipeline/schemas/orchestrator.schema.json
`,
    ".pipeline/pipeline.yaml":
      options.pipeline ??
      `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
    ".agents/skills/present/SKILL.md": `
---
name: present
---

# Present
`,
    ".pipeline/prompts/orchestrator.md": "Orchestrate\n",
    ".pipeline/schemas/orchestrator.schema.json": `{"type":"object"}\n`,
  });
}

function writeProjectFileSet(
  root: string,
  files: Record<string, string>
): void {
  for (const [path, content] of Object.entries(files)) {
    writeCliProjectFile(root, path, content.trimStart());
  }
}

function mockToolHiveWorkloads(names: string[]): void {
  mockExeca.mockImplementation(((
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ) => {
    const result = toolHiveListResult(command, args, names);
    writeHookResult(command, options);
    installSkillsForCommand(command, args, options);
    return Promise.resolve(result ?? emptyExecaResult()) as any;
  }) as any);
}

function toolHiveListResult(
  command: string,
  args: string[] | undefined,
  names: string[]
): { exitCode: number; stderr: string; stdout: string } | undefined {
  return isToolHiveListCommand(command, args)
    ? {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(names.map(toolHiveWorkload)),
      }
    : undefined;
}

function isToolHiveListCommand(
  command: string,
  args: string[] | undefined
): boolean {
  return (
    command === "thv" &&
    Array.isArray(args) &&
    args.includes("list") &&
    args.includes("--format") &&
    args.includes("json")
  );
}

function toolHiveWorkload(name: string): Record<string, string> {
  return {
    group: "default",
    name,
    status: "running",
    transport_type: "streamable-http",
    url: `http://127.0.0.1/${name}/mcp/`,
  };
}

function writeHookResult(
  command: string,
  options: { env?: Record<string, string> } | undefined
): void {
  const resultPath = options?.env?.PIPELINE_HOOK_RESULT;
  if (resultPath) {
    writeFileSync(
      resultPath,
      JSON.stringify({ status: "pass", summary: command })
    );
  }
}

function installSkillsForCommand(
  command: string,
  args: string[] | undefined,
  options: { cwd?: string } | undefined
): void {
  if (isSkillsInstallCommand(command, args)) {
    installMockSkills(args, options?.cwd);
  }
}

function isSkillsInstallCommand(
  command: string,
  args: string[] | undefined
): args is string[] {
  return (
    command === "npx" &&
    Array.isArray(args) &&
    args.includes("skills") &&
    args.includes("add")
  );
}

function emptyExecaResult(): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  return { exitCode: 0, stderr: "", stdout: "" };
}

const COMPLETE_TOOLHIVE_WORKLOADS = [
  "backlog",
  "context7",
  "oisin-pipeline-fallow",
  "oisin-pipeline-qdrant",
  "serena",
  "uidotsh",
];

function writeThermoNuclearReviewValidateFixture(
  root: string,
  options: { includeSkill: boolean }
): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash]
      filesystem: [read-only]
      network: [inherit]
      output_formats: [text, json_schema]
`,
    ".pipeline/profiles.yaml": `
version: 1
skills:
  thermo-nuclear-code-quality-review:
    path: .agents/skills/thermo-nuclear-code-quality-review/SKILL.md
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: codex
    instructions:
      inline: Orchestrate
    filesystem:
      mode: read-only
  pipeline-thermo-nuclear-reviewer:
    runner: codex
    instructions:
      path: .agents/skills/thermo-nuclear-code-quality-review/SKILL.md
    skills: [thermo-nuclear-code-quality-review]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/review.schema.json
      repair:
        enabled: true
        max_attempts: 1
`,
    ".pipeline/pipeline.yaml": `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: review
        kind: agent
        profile: pipeline-thermo-nuclear-reviewer
`,
    ".pipeline/schemas/review.schema.json": `{"type":"object"}\n`,
  });

  if (options.includeSkill) {
    writeCliProjectFile(
      root,
      ".agents/skills/thermo-nuclear-code-quality-review/SKILL.md",
      "---\nname: thermo-nuclear-code-quality-review\n---\n\n# Thermo-Nuclear Code Quality Review\n"
    );
  }
}

function execaCommands(): string[] {
  return mockExeca.mock.calls.map(([command]) => String(command));
}

// ─── backlog.ts ───────────────────────────────────────────────────────────────

function backlogCreateOutput(id: string, title: string): string {
  return `File: /tmp/wt/backlog/tasks/${id.toLowerCase()} - slug.md\n\nTask ${id} - ${title}\n==================================================\n`;
}

describe("createSwarmTasks", () => {
  it("creates parent + 5 child tasks via backlog and returns the assigned id map", async () => {
    const { createSwarmTasks } = await import("../src/backlog");

    // Sequence of backlog task create stdouts: parent, then R, TW, CW, V, L children
    mockExeca
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10", "pipe task"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.1", "research"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.2", "test-write"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.3", "implement"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.4", "verify"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("TASK-10.5", "learn"),
        exitCode: 0,
      } as any);

    const swarm = await createSwarmTasks("pipe task", "/tmp/wt");

    expect(swarm).toEqual({
      parentId: "TASK-10",
      phases: {
        R: "TASK-10.1",
        TW: "TASK-10.2",
        CW: "TASK-10.3",
        V: "TASK-10.4",
        L: "TASK-10.5",
      },
    });
    // 6 calls total: 1 parent + 5 children
    const createCalls = mockExeca.mock.calls.filter((c) => {
      const args = c[1] as string[] | undefined;
      return (
        c[0] === "backlog" && args?.[0] === "task" && args?.[1] === "create"
      );
    });
    expect(createCalls.length).toBe(6);
  });

  it("threads worktree path as cwd into every backlog invocation", async () => {
    const { createSwarmTasks } = await import("../src/backlog");

    mockExeca.mockResolvedValue({
      stdout: backlogCreateOutput("TASK-1", "x"),
      exitCode: 0,
    } as any);

    await createSwarmTasks("x", "/some/wt");

    for (const call of mockExeca.mock.calls) {
      if (call[0] === "backlog") {
        expect(
          (call as unknown as [string, string[], { cwd: string }])[2]
        ).toMatchObject({ cwd: "/some/wt" });
      }
    }
  });

  it("accepts custom Backlog task prefixes from real CLI output", async () => {
    const { createSwarmTasks } = await import("../src/backlog");

    mockExeca
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("PIPE-1", "pipe task"),
        exitCode: 0,
      } as any)
      .mockResolvedValueOnce({
        stdout: backlogCreateOutput("PIPE-1.1", "research"),
        exitCode: 0,
      } as any)
      .mockResolvedValue({
        stdout: backlogCreateOutput("PIPE-1.2", "phase"),
        exitCode: 0,
      } as any);

    const swarm = await createSwarmTasks("pipe task", "/tmp/wt");

    expect(swarm.parentId).toBe("PIPE-1");
    expect(swarm.phases.R).toBe("PIPE-1.1");
  });

  it("does not append --no-git to backlog calls (init-only flag in upstream)", async () => {
    const { createSwarmTasks } = await import("../src/backlog");

    mockExeca.mockResolvedValue({
      stdout: backlogCreateOutput("TASK-1", "x"),
      exitCode: 0,
    } as any);

    await createSwarmTasks("PIPE-42", "/tmp/wt");

    for (const call of mockExeca.mock.calls) {
      if (call[0] === "backlog") {
        expect(call[1]).not.toContain("--no-git");
      }
    }
  });
});

describe("markPhase", () => {
  it("calls backlog task edit with --status against the assigned id", async () => {
    const { markPhase } = await import("../src/backlog");

    mockExeca.mockResolvedValue({ stdout: "", exitCode: 0 } as any);

    await markPhase("TASK-10.1", "Done", "/tmp/wt");

    expect(mockExeca).toHaveBeenCalledWith(
      "backlog",
      expect.arrayContaining(["task", "edit", "TASK-10.1", "--status", "Done"]),
      expect.objectContaining({ cwd: "/tmp/wt" })
    );
  });
});

describe("planPhaseLifecycle", () => {
  const SWARM = {
    parentId: "TASK-99",
    phases: {
      R: "TASK-99.1",
      TW: "TASK-99.2",
      CW: "TASK-99.3",
      V: "TASK-99.4",
      L: "TASK-99.5",
    },
  } as const;

  it("plans each phase In Progress then Done for a successful run", async () => {
    const { planPhaseLifecycle } = await import("../src/backlog");

    const result = planPhaseLifecycle(SWARM, {
      outcome: "PASS",
      failureDetails: [],
    });

    expect(result.statusUpdates).toEqual([
      { taskId: "TASK-99.1", status: "In Progress" },
      { taskId: "TASK-99.1", status: "Done" },
      { taskId: "TASK-99.2", status: "In Progress" },
      { taskId: "TASK-99.2", status: "Done" },
      { taskId: "TASK-99.3", status: "In Progress" },
      { taskId: "TASK-99.3", status: "Done" },
      { taskId: "TASK-99.4", status: "In Progress" },
      { taskId: "TASK-99.4", status: "Done" },
      { taskId: "TASK-99.5", status: "In Progress" },
      { taskId: "TASK-99.5", status: "Done" },
    ]);
    expect(result.failureNote).toBeUndefined();
  });

  it("stops at the gate failure phase and records failure context", async () => {
    const { planPhaseLifecycle } = await import("../src/backlog");

    const result = planPhaseLifecycle(SWARM, {
      outcome: "FAIL",
      failureDetails: [
        {
          gate: "GREEN",
          reason: "tests failed",
          evidence: ["expected 2 received 1"],
        },
      ],
    });

    expect(result.statusUpdates).toEqual([
      { taskId: "TASK-99.1", status: "In Progress" },
      { taskId: "TASK-99.1", status: "Done" },
      { taskId: "TASK-99.2", status: "In Progress" },
      { taskId: "TASK-99.2", status: "Done" },
      { taskId: "TASK-99.3", status: "In Progress" },
    ]);
    expect(result.failureNote).toEqual({
      taskId: "TASK-99.3",
      note: "GREEN gate failed: tests failed\n\nEvidence:\n- expected 2 received 1",
    });
  });
});

// ─── CLI entry ────────────────────────────────────────────────────────────────

describe("pipe", () => {
  it("exports a pipe function", async () => {
    const mod = await import("../src/index");
    expect(typeof mod.pipe).toBe("function");
  });

  it("supports direct pipe init invocation from the pipe binary", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-init-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

      expect(existsSync(join(dir, ".pipeline"))).toBe(false);
      expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
      expect(existsSync(join(dir, ".agents/skills/pipe/SKILL.md"))).toBe(true);
      expect(existsSync(join(dir, ".opencode/commands/pipe.md"))).toBe(true);
      expect(existsSync(join(dir, ".codex/config.toml"))).toBe(true);
      expect(existsSync(join(dir, ".opencode/opencode.json"))).toBe(true);
      expect(
        mockExeca.mock.calls.some(
          ([command, args]) =>
            command === "uvx" && Array.isArray(args) && args.includes("mcpm")
        )
      ).toBe(false);
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not run MCPM registration during init", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-init-redacted-mcp-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION =
        "Basic test-basic-payload";
      mockExeca.mockImplementation(((
        command: string,
        args?: string[],
        options?: { cwd?: string }
      ) => {
        if (
          command === "npx" &&
          Array.isArray(args) &&
          args.includes("skills") &&
          args.includes("add")
        ) {
          installMockSkills(
            args,
            (options as { cwd?: string } | undefined)?.cwd
          );
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      }) as any);

      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

      expect(
        mockExeca.mock.calls.some(
          ([command, args]) =>
            command === "uvx" && Array.isArray(args) && args.includes("mcpm")
        )
      ).toBe(false);
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initializes gateway-only MCP config when gateway authorization is missing", async () => {
    await withCliTempDir(
      "pipeline-cli-init-missing-gateway-auth-",
      async ({ dir, output, runCli }) => {
        delete process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;

        await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

        expect(
          mockExeca.mock.calls.some(
            ([command, args]) =>
              command === "uvx" &&
              Array.isArray(args) &&
              args.includes("oisin-pipeline-qdrant")
          )
        ).toBe(false);
        expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
        expect(existsSync(join(dir, ".pipeline"))).toBe(false);
        const stdout = output();
        expect(stdout).not.toContain("Skipped MCPM registration");
        expect(stdout).not.toContain("PIPELINE_MCP_GATEWAY_AUTHORIZATION");
      }
    );
  });

  it("initializes host resources into PIPELINE_TARGET_PATH", async () => {
    await withCliTempDir("pipeline-cli-install-", async ({ dir, runCli }) => {
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

      expect(existsSync(join(dir, ".opencode", "commands", "pipe.md"))).toBe(
        true
      );
      expect(existsSync(join(dir, ".opencode", "opencode.json"))).toBe(true);
      const opencode = JSON.parse(
        readFileSync(join(dir, ".opencode", "opencode.json"), "utf8")
      );
      expect(opencode.mcp["pipeline-gateway"]).toMatchObject({
        type: "remote",
        url: "http://127.0.0.1:4483/mcp",
      });
      expect(
        existsSync(join(process.cwd(), ".opencode", "commands", "pipe.md"))
      ).toBe(true);
    });
  });

  it("detects relative Node entrypoint paths as CLI executions", async () => {
    const { isCliEntrypoint } = await import("../src/index");
    const sourcePath = fileURLToPath(
      new URL("../src/index.ts", import.meta.url)
    );

    expect(isCliEntrypoint(["node", relative(process.cwd(), sourcePath)])).toBe(
      true
    );
  });

  it("declares installable binaries and typed subpath exports", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as {
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
    };

    expect(pkg).toMatchObject({
      name: "@oisincoveney/pipeline",
      publishConfig: { access: "public" },
    });
    expect(pkg.bin).toEqual({
      "oisin-pipeline": "dist/index.js",
      pipe: "dist/index.js",
    });
    expect(pkg.exports?.["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./pipeline-primitive"]).toBeUndefined();
    expect(pkg.exports?.["./runner"]).toEqual({
      import: "./dist/runner.js",
      types: "./dist/runner.d.ts",
    });
    expect(pkg.exports?.["./config"]).toEqual({
      import: "./dist/config.js",
      types: "./dist/config.d.ts",
    });
    expect(pkg.exports?.["./hooks"]).toEqual({
      import: "./dist/hooks.js",
      types: "./dist/hooks.d.ts",
    });
    expect(pkg.exports?.["./planner"]).toEqual({
      import: "./dist/workflow-planner.js",
      types: "./dist/workflow-planner.d.ts",
    });
    expect(pkg.exports?.["./runtime"]).toEqual({
      import: "./dist/pipeline-runtime.js",
      types: "./dist/pipeline-runtime.d.ts",
    });
    expect(pkg.exports?.["./runner-job-contract"]).toEqual({
      import: "./dist/runner-job-contract.js",
      types: "./dist/runner-job-contract.d.ts",
    });
  });

  it("throws if no description provided", async () => {
    const { pipe } = await import("../src/index");
    await expect(pipe("")).rejects.toThrow(DESCRIPTION_RE);
  });

  it("runs the YAML runtime through the pipe function", async () => {
    const { pipe } = await import("../src/index");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const pipelineRunner = vi.fn().mockImplementation(({ reporter }) => {
      reporter?.({
        nodeIds: ["inspect"],
        type: "workflow.start",
        workflowId: "custom",
      });
      reporter?.({
        attempt: 1,
        nodeId: "inspect",
        profile: "pipeline-inspector",
        runnerId: "codex",
        type: "node.start",
      });
      reporter?.({
        actor: {
          id: "pipeline.node.run-123.custom.inspect",
          kind: "node",
          systemId: "pipeline.run-123",
        },
        level: "info",
        name: "runtime.state.enter",
        nodeId: "inspect",
        summary:
          "node actor pipeline.node.run-123.custom.inspect entered running",
        type: "runtime.observability",
        workflowId: "custom",
      });
      reporter?.({
        attempt: 1,
        exitCode: 0,
        nodeId: "inspect",
        status: "passed",
        type: "node.finish",
      });
      reporter?.({
        outcome: "PASS",
        type: "workflow.finish",
        workflowId: "custom",
      });
      return Promise.resolve({
        agentInvocations: [],
        outcome: "PASS",
        failureDetails: [],
        gates: [],
        hookFailures: [],
        nodes: [
          {
            attempts: 1,
            evidence: [],
            exitCode: 0,
            nodeId: "inspect",
            output: "repo report",
            status: "passed",
          },
        ],
        plan: {
          workflowId: "custom",
          parallelBatches: [],
          topologicalOrder: [],
        },
      });
    });

    let progress: string[] = [];
    let finalOutput = "";
    try {
      await pipe("PIPE-42 trivial NOOP", {
        pipelineRunner,
        workflow: "custom",
      });
      progress = error.mock.calls.map(([message]) => String(message));
    } finally {
      error.mockRestore();
      finalOutput = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      log.mockRestore();
    }

    expect(pipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        entrypoint: undefined,
        reporter: expect.any(Function),
        task: "PIPE-42 trivial NOOP",
        workflowId: "custom",
        worktreePath: process.cwd(),
      })
    );
    expect(progress).toContain("Pipeline starting: custom (inspect)");
    expect(progress).toContain(
      "Node starting: inspect runner=codex profile=pipeline-inspector attempt=1"
    );
    expect(progress).toContain(
      "Runtime observed: runtime.state.enter - node actor pipeline.node.run-123.custom.inspect entered running"
    );
    expect(progress).toContain("Node finished: inspect passed exit=0");
    expect(progress).toContain("Pipeline finished: custom PASS");
    expect(finalOutput).toContain("Node outputs:");
    expect(finalOutput).toContain("repo report");
  });

  it("passes entrypoint aliases through the CLI runner", async () => {
    const { pipe } = await import("../src/index");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const pipelineRunner = vi.fn().mockResolvedValue({
      agentInvocations: [],
      failureDetails: [],
      gates: [],
      hookFailures: [],
      nodes: [],
      outcome: "PASS",
      plan: {
        workflowId: "default",
        parallelBatches: [],
        topologicalOrder: [],
      },
    });

    try {
      await pipe("ship", { entrypoint: "quick", pipelineRunner });
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    expect(pipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        entrypoint: "quick",
        task: "ship",
      })
    );
  });

  it("generates and executes schedule artifacts for scheduled pipe entrypoints", async () => {
    await withCliTempDir(
      "pipeline-cli-schedule-plan-",
      async ({ dir, output, runCli }) => {
        writeScheduledCliConfig(dir);
        process.env.PIPELINE_TEST_COMMAND = "test-bin";

        await runCli(["node", "/repo/node_modules/.bin/pipe", "ship", "it"]);

        const stdout = output();
        expect(stdout).toContain("Schedule generated:");
        expect(stdout).not.toContain("Run after approval:");
        expect(stdout).toMatch(SCHEDULE_RUN_WORKFLOW_RE);
        expect(execaCommands()).toContain("opencode");
        expect(stdout).toMatch(SCHEDULE_MEMORY_ID_RE);
        expect(existsSync(join(dir, ".pipeline", "runs"))).toBe(false);
      }
    );
  });

  it("executes a schedule artifact via run --schedule", async () => {
    await withCliTempDir(
      "pipeline-cli-schedule-run-",
      async ({ dir, output, runCli }) => {
        writeScheduledCliConfig(dir);
        const schedulePath = join(dir, "approved-schedule.yaml");
        writeFileSync(
          schedulePath,
          `
version: 1
kind: pipeline-schedule
schedule_id: approved-a
source_entrypoint: pipe
task: Ship it
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: scheduled
        kind: command
        command: [scheduled-bin]
        task_context:
          id: PC-37.2
          title: Build API endpoint
          description: Build the console API endpoint.
          acceptance_criteria:
            - id: "1"
              text: Endpoint validates runner events.
`
        );

        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "run",
          "--schedule",
          schedulePath,
          "Ship",
          "it",
        ]);

        expect(mockExeca).toHaveBeenCalledWith(
          "scheduled-bin",
          [],
          expect.objectContaining({ cwd: dir })
        );
        expect(output()).toContain("Workflow: schedule-approved-a-root");
      }
    );
  });

  it("executes package-backed schedule agents through CLI subprocesses", async () => {
    await withCliTempDir(
      "pipeline-cli-schedule-opencode-",
      async ({ dir, output, runCli }) => {
        writeScheduledCliConfig(dir);
        mockExeca.mockImplementation(((
          command: string,
          args?: string[],
          options?: { env?: Record<string, string> }
        ) => {
          if (options?.env?.PIPELINE_HOOK_RESULT) {
            writeFileSync(
              options.env.PIPELINE_HOOK_RESULT,
              JSON.stringify({ status: "pass", summary: command })
            );
          }
          if (command === "opencode" || command === "codex") {
            return Promise.resolve({
              exitCode: 0,
              stderr: "",
              stdout: mockAgentStdout(command, args),
            }) as any;
          }
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: "",
          }) as any;
        }) as any);
        const schedulePath = join(dir, "approved-opencode-schedule.yaml");
        writeFileSync(
          schedulePath,
          `
version: 1
kind: pipeline-schedule
schedule_id: approved-opencode
source_entrypoint: pipe
task: Ship it with OpenCode
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: pipeline-code-writer
`
        );

        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "run",
          "--schedule",
          schedulePath,
          "Ship",
          "it",
        ]);

        expect(mockExeca).toHaveBeenCalledWith(
          "opencode",
          expect.arrayContaining(["run", "--model", "openai/gpt-5.5"]),
          expect.objectContaining({ cwd: dir })
        );
        expect(output()).toContain("Workflow: schedule-approved-opencode-root");
      }
    );
  });

  it("validates and explains a schedule artifact", async () => {
    await withCliTempDir(
      "pipeline-cli-schedule-inspect-",
      async ({ dir, output, runCli }) => {
        writeScheduledCliConfig(dir);
        const schedulePath = join(dir, "approved-schedule.yaml");
        writeFileSync(
          schedulePath,
          `
version: 1
kind: pipeline-schedule
schedule_id: approved-b
source_entrypoint: pipe
task: Inspect it
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: scheduled
        kind: command
        command: [scheduled-bin]
`
        );

        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "validate",
          "--schedule",
          schedulePath,
        ]);
        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "explain-plan",
          "--schedule",
          schedulePath,
        ]);

        const stdout = output();
        expect(stdout).toContain("OK: schedule-approved-b-root (1 nodes)");
        expect(stdout).toContain("Workflow: schedule-approved-b-root");
        expect(stdout).toContain("- scheduled kind=command needs=none");
        expect(stdout).not.toContain("Unrecognized key: task_context");
        expect(execaCommands()).toEqual([]);
      }
    );
  });

  it("dispatches package entrypoint subcommands from package config", async () => {
    await withCliTempDir(
      "pipeline-cli-entrypoint-",
      async ({ dir, runCli }) => {
        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "inspect",
          "ship",
          "it",
        ]);

        expect(mockExeca).toHaveBeenCalledWith(
          "opencode",
          expect.arrayContaining(["run", "--model", "openai/gpt-5.5"]),
          expect.objectContaining({ cwd: dir })
        );
        expect(execaCommands()).not.toContain("quick-node-bin");
      }
    );
  });

  it("lists package entrypoint subcommands with descriptions in pipe help", async () => {
    await withCliTempDir("pipeline-cli-entrypoint-help-", async () => {
      const { createCliProgram } = await import("../src/index");
      const help = createCliProgram().helpInformation();

      expect(help).toMatch(PACKAGE_INSPECT_COMMAND_RE);
      expect(help).toMatch(PACKAGE_EPIC_COMMAND_RE);
    });
  });

  it("describes package-owned config as the runtime source in pipe help", async () => {
    await withCliTempDir("pipeline-cli-package-help-", async () => {
      const { createCliProgram } = await import("../src/index");
      const help = createCliProgram().helpInformation();

      expect(help).toContain("package-owned @oisincoveney/pipeline config");
      expect(help).not.toContain(".pipeline/pipeline.yaml");
      expect(help).not.toMatch(PIPELINE_YAML_SOURCE_RE);
    });
  });

  it("lets builtin collision commands win over configured entrypoints", async () => {
    await withCliTempDir(
      "pipeline-cli-collision-",
      async ({ dir, output, runCli }) => {
        writeCliEntrypointConfig(dir);

        await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

        const stdout = output();
        expect(stdout).toContain("OK: default");
        expect(stdout).not.toContain("validate-entrypoint");
        expect(execaCommands()).not.toContain("validate-start-bin");
        expect(execaCommands()).not.toContain("validate-entrypoint-bin");
      }
    );
  });

  it("supports the package collision escape hatch via pipe run --entrypoint", async () => {
    await withCliTempDir("pipeline-cli-collision-run-", async ({ runCli }) => {
      process.env.PIPELINE_TEST_COMMAND = "test-bin";

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "run",
        "--entrypoint",
        "pipe",
        "ship",
        "collision",
      ]);

      expect(execaCommands()).toContain("opencode");
    });
  });

  it("keeps pipe init and doctor bootstrap commands reachable without config", async () => {
    const { runCli } = await import("../src/index");
    const initDir = mkdtempSync(join(tmpdir(), "pipeline-cli-bootstrap-init-"));
    const doctorDir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-bootstrap-doctor-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = initDir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      expect(existsSync(join(initDir, ".pipeline"))).toBe(false);

      process.env.PIPELINE_TARGET_PATH = doctorDir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "doctor"]);
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("PASS pipeline-config: valid");
    } finally {
      log.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(initDir, { recursive: true, force: true });
      rmSync(doctorDir, { recursive: true, force: true });
    }
  });

  it("ignores malformed repo-local pipeline config because package config owns runtime", async () => {
    await withCliTempDir("pipeline-cli-malformed-", async ({ dir, runCli }) => {
      writeMalformedCliConfig(dir);
      process.env.PIPELINE_TEST_COMMAND = "test-bin";

      await expect(
        runCli(["node", "/repo/node_modules/.bin/pipe", "ship", "it"])
      ).resolves.toBeUndefined();
      expect(execaCommands()).toContain("opencode");
    });
  });

  it("runs from package config when pipe is invoked without repo pipeline config", async () => {
    await withCliTempDir("pipeline-cli-missing-", async ({ runCli }) => {
      process.env.PIPELINE_TEST_COMMAND = "test-bin";
      await expect(
        runCli(["node", "/repo/node_modules/.bin/pipe", "ship it"])
      ).resolves.toBeUndefined();
      expect(execaCommands()).toContain("opencode");
    });
  });

  it("does not repair partial repo-local pipeline files", async () => {
    await withCliTempDir(
      "pipeline-cli-partial-init-",
      async ({ dir, output, runCli }) => {
        writeCliProjectFile(
          dir,
          ".pipeline/pipeline.yaml",
          "version: 1\ndefault_workflow: default\nworkflows: {}\n"
        );

        await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

        expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(false);
        expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(false);
        expect(output()).toContain(
          "no repo-local pipeline config files were created"
        );
      }
    );
  });

  it("validates and explains the initialized YAML plan", async () => {
    await withCliTempDir("pipeline-cli-plan-", async ({ output, runCli }) => {
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);
      await runCli(["node", "/repo/node_modules/.bin/pipe", "explain-plan"]);
      await runCli(["node", "/repo/node_modules/.bin/pipe", "doctor"]);

      const stdout = output();
      expect(stdout).toContain("OK: default");
      expect(stdout).toContain("Workflow: default");
      expect(stdout).not.toContain("strategy=");
      expect(stdout).toContain("Doctor: PASS");
    });
  });

  it("validates the epic-drain workflow without treating current warnings as fatal", async () => {
    await withCliTarget(process.cwd(), async (fixture) => {
      const { failureText, stderr, stdout, thrown } =
        await runPackageWorkflowCommand(fixture, "validate");
      expect(failureText).not.toMatch(UNKNOWN_ENTRYPOINT_OR_CONFIG_RE);
      expect(thrown).toBeUndefined();
      expect(stderr).toContain(
        "WARN entrypoint-shadowed: entrypoint 'pipe' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint pipe ...'"
      );
      expect(stdout).toContain("OK: epic-drain");
    });
  });

  it("explains the epic-drain package workflow topology", async () => {
    await withCliTarget(process.cwd(), async (fixture) => {
      const { failureText, stdout, thrown } = await runPackageWorkflowCommand(
        fixture,
        "explain-plan"
      );
      expect(failureText).not.toMatch(UNKNOWN_ENTRYPOINT_OR_CONFIG_RE);
      expect(thrown).toBeUndefined();
      expect(stdout).toContain("Workflow: epic-drain");
      expect(stdout).toContain(
        "Batches: [research] -> [plan] -> [implement] -> [merge] -> [review]"
      );
      expect(stdout).toMatch(PLAN_RESEARCH_RE);
      expect(stdout).toMatch(PLAN_PLAN_RE);
      expect(stdout).toMatch(PLAN_IMPLEMENT_RE);
      expect(stdout).toMatch(PLAN_MERGE_RE);
      expect(stdout).toMatch(PLAN_REVIEW_RE);
    });
  });

  it("validate emits WARN entrypoint-shadowed when configured entrypoints collide with builtins", async () => {
    await withCliTempDir("pipeline-cli-lint-entrypoint-", async (fixture) => {
      const { stderr, stdout } = await validateCliLintFixture(fixture, {
        pipeline: `
version: 1
default_workflow: default
entrypoints:
  validate:
    workflow: default
    description: Shadow validate
  pipe:
    workflow: default
    description: Shadow pipe
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
      });

      expect(stderr).toContain(
        "WARN entrypoint-shadowed: entrypoint 'pipe' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint pipe ...'"
      );
      expect(stdout).toContain("OK: default");
    });
  });

  it("validate ignores repo-local optional asset paths and validates package config", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-missing-",
      async ({ dir, output, runCli, stderr }) => {
        writeCliValidateLintConfig(dir, {
          profiles: `
version: 1
skills:
  missing-skill:
    path: .agents/skills/missing/SKILL.md
profiles:
  orchestrator:
    runner: local
    instructions:
      path: .pipeline/prompts/missing.md
    skills: [missing-skill]
    output:
      format: json_schema
      schema_path: .pipeline/schemas/missing.schema.json
`,
        });

        await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

        const stderrOutput = stderr();
        expect(stderrOutput).not.toContain("missing-skill");
        expect(stderrOutput).not.toContain(".pipeline/prompts/missing.md");
        expect(output()).toContain("OK: default");
      }
    );
  });

  it("validate does not warn about missing epic-router asset files once the bundle exists", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-epic-router-",
      async ({ dir, output, runCli, stderr }) => {
        writeProjectFileSet(dir, {
          ".pipeline/runners.yaml": `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash]
      filesystem: [read-only]
      network: [inherit]
      output_formats: [text, json_schema]
`,
          ".pipeline/profiles.yaml": `
version: 1
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: codex
    instructions:
      inline: Orchestrate
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
    network:
      mode: inherit
  pipeline-epic-router:
    runner: codex
    instructions:
      path: .pipeline/prompts/epic-router.md
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/epic-plan.schema.json
      repair:
        enabled: true
        max_attempts: 1
`,
          ".pipeline/pipeline.yaml": `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
        });
        for (const assetPath of [
          ".pipeline/prompts/epic-router.md",
          ".pipeline/schemas/epic-plan.schema.json",
        ]) {
          const sourcePath = join(process.cwd(), assetPath);
          if (existsSync(sourcePath)) {
            writeCliProjectFile(
              dir,
              assetPath,
              readFileSync(sourcePath, "utf8")
            );
          }
        }

        await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

        const stderrOutput = stderr();
        expect(stderrOutput).not.toContain(
          "profiles.pipeline-epic-router.instructions.path references missing file '.pipeline/prompts/epic-router.md'"
        );
        expect(stderrOutput).not.toContain(
          "profiles.pipeline-epic-router.output.schema_path references missing file '.pipeline/schemas/epic-plan.schema.json'"
        );
        expect(stderrOutput).not.toContain("WARN missing-file-reference");
        expect(output()).toContain("OK: default");
      }
    );
  });

  it("validate --strict rejects package lint warnings without repo-local missing-file warnings", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-thermo-review-present-",
      async ({ dir, runCli, stderr }) => {
        writeThermoNuclearReviewValidateFixture(dir, { includeSkill: true });

        await expect(
          runCli([
            "node",
            "/repo/node_modules/.bin/pipe",
            "validate",
            "--strict",
          ])
        ).rejects.toThrow(WARNING_RE);

        const stderrOutput = stderr();
        expect(stderrOutput).not.toContain("WARN missing-file-reference");
        expect(stderrOutput).not.toContain(
          "skills.thermo-nuclear-code-quality-review.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'"
        );
        expect(stderrOutput).not.toContain(
          "profiles.pipeline-thermo-nuclear-reviewer.instructions.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'"
        );
        expect(stderrOutput).not.toContain(
          "profiles.pipeline-thermo-nuclear-reviewer.output.schema_path references missing file '.pipeline/schemas/review.schema.json'"
        );
        expect(stderrOutput).toContain("WARN entrypoint-shadowed");
      }
    );
  });

  it("validate does not emit repo-local thermo-nuclear review missing-file warnings", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-thermo-review-missing-",
      async ({ dir, output, runCli, stderr }) => {
        writeThermoNuclearReviewValidateFixture(dir, { includeSkill: false });

        await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

        const missingFileWarnings = stderr()
          .split("\n")
          .filter((line) => line.includes("WARN missing-file-reference"));
        expect(missingFileWarnings).toEqual([]);
        expect(output()).toContain("OK: default");
      }
    );
  });

  it("validate ignores repo-local singleton parallel lint fixtures", async () => {
    await withCliTempDir("pipeline-cli-lint-parallel-", async (fixture) => {
      const { stderr, stdout } = await validateCliLintFixture(fixture, {
        pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: only
            kind: command
            command: [node, --version]
`,
      });

      expect(stderr).not.toContain("WARN singleton-parallel");
      expect(stdout).toContain("OK: default");
    });
  });

  it("validate ignores repo-local worktree-root style lint fixtures", async () => {
    await withCliTempDir("pipeline-cli-lint-worktree-", async (fixture) => {
      const { stderr, stdout } = await validateCliLintFixture(fixture, {
        pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: nested
        kind: workflow
        workflow: child
        worktree_root: tmp/pipeline-runs/\${runId}/\${nodeId}
  child:
    nodes:
      - id: child-task
        kind: command
        command: [node, --version]
`,
      });

      expect(stderr).not.toContain("WARN worktree-root-style");
      expect(stdout).toContain("OK: default");
    });
  });

  it("validate --strict rejects when lint warnings exist and still emits WARN output", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-strict-",
      async ({ dir, runCli, stderr }) => {
        writeCliValidateLintConfig(dir, {
          pipeline: `
version: 1
default_workflow: default
entrypoints:
  validate:
    workflow: default
    description: Shadow validate
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
        });

        await expect(
          runCli([
            "node",
            "/repo/node_modules/.bin/pipe",
            "validate",
            "--strict",
          ])
        ).rejects.toThrow(WARNING_RE);

        expect(stderr()).toContain(
          "WARN entrypoint-shadowed: entrypoint 'pipe' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint pipe ...'"
        );
      }
    );
  });

  it("validate --no-lint skips WARN output and succeeds schema and plan validation only", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-disabled-",
      async ({ dir, output, runCli, stderr }) => {
        writeCliValidateLintConfig(dir, {
          profiles: `
version: 1
skills:
  missing-skill:
    path: .agents/skills/missing/SKILL.md
profiles:
  orchestrator:
    runner: local
    instructions:
      path: .pipeline/prompts/missing.md
    skills: [missing-skill]
    output:
      format: json_schema
      schema_path: .pipeline/schemas/missing.schema.json
`,
        });

        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "validate",
          "--no-lint",
        ]);

        expect(stderr()).not.toContain("WARN ");
        expect(output()).toContain("OK: default");
      }
    );
  });

  it("validate --no-lint ignores malformed repo-local schemas and validates package config", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-schema-",
      async ({ dir, runCli, stderr }) => {
        writeMalformedCliConfig(dir);

        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "validate",
          "--strict",
          "--no-lint",
        ]);

        expect(stderr()).not.toContain("WARN ");
      }
    );
  });

  it("validate ignores repo-local undefined workflow fixtures", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-workflow-",
      async ({ dir, runCli, stderr }) => {
        writeCliValidateLintConfig(dir, {
          pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: missing-child
        kind: workflow
        workflow: undefined-child
`,
        });

        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "validate",
          "--no-lint",
        ]);

        expect(stderr()).not.toContain("WARN ");
      }
    );
  });

  it("doctor reports missing prerequisites", async () => {
    await withCliTempDir("pipeline-cli-doctor-", async ({ dir, runCli }) => {
      const { runDoctor } = await import("../src/index");
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      mockExeca.mockImplementation(((command: string) => {
        if (command === "opencode") {
          return Promise.reject({ shortMessage: "opencode missing" });
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      }) as any);

      const result = await runDoctor(dir);

      expect(result.passed).toBe(false);
      expect(result.checks).toContainEqual({
        detail: "opencode missing",
        name: "opencode",
        passed: false,
      });
    });
  });

  it("configures project host MCP config as gateway-only with backups", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-configure-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalGatewayUrl = process.env.PIPELINE_MCP_GATEWAY_URL;
    const originalGatewayToken = process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.PIPELINE_MCP_GATEWAY_URL = "https://gateway.example/mcp";
      process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-token";
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      mkdirSync(join(dir, ".codex"), { recursive: true });
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(
        join(dir, ".codex/config.toml"),
        ["[mcp_servers.legacy]", 'command = "uvx"', ""].join("\n")
      );
      writeFileSync(
        join(dir, ".opencode/opencode.json"),
        JSON.stringify({ mcp: { legacy: { type: "local" } } })
      );

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "mcp",
        "gateway",
        "configure-host",
      ]);

      const codex = readFileSync(join(dir, ".codex/config.toml"), "utf8");
      const opencode = JSON.parse(
        readFileSync(join(dir, ".opencode/opencode.json"), "utf8")
      );
      expect(codex).toContain("[mcp_servers.pipeline-gateway]");
      expect(codex).toContain('url = "https://gateway.example/mcp"');
      expect(codex).toContain(
        "[mcp_servers.pipeline-gateway.env_http_headers]"
      );
      expect(codex).toContain(
        'Authorization = "PIPELINE_MCP_GATEWAY_AUTHORIZATION"'
      );
      expect(codex).not.toContain("legacy");
      expect(opencode.mcp["pipeline-gateway"]).toMatchObject({
        enabled: true,
        oauth: false,
        type: "remote",
        url: "https://gateway.example/mcp",
      });
      expect(opencode.mcp.legacy).toBeUndefined();
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(".codex/config.toml");
      expect(output).toContain(".opencode/opencode.json");
      expect(output).toContain("backup=");
    } finally {
      log.mockRestore();
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("PIPELINE_MCP_GATEWAY_URL", originalGatewayUrl);
      restoreEnv("PIPELINE_MCP_GATEWAY_AUTHORIZATION", originalGatewayToken);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gateway doctor detects legacy direct MCP config", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-doctor-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalGatewayUrl = process.env.PIPELINE_MCP_GATEWAY_URL;
    const originalGatewayToken = process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
    const originalFetch = global.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.PIPELINE_MCP_GATEWAY_URL = "http://127.0.0.1:4483/mcp";
      process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-token";
      global.fetch = vi.fn().mockResolvedValue({ status: 200 }) as any;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { legacy: { command: "uvx" } } })
      );

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "mcp",
          "gateway",
          "doctor",
        ])
      ).rejects.toThrow("MCP gateway doctor checks failed.");

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("legacy-direct-mcp");
      expect(output).toContain(".mcp.json");
    } finally {
      log.mockRestore();
      global.fetch = originalFetch;
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("PIPELINE_MCP_GATEWAY_URL", originalGatewayUrl);
      restoreEnv("PIPELINE_MCP_GATEWAY_AUTHORIZATION", originalGatewayToken);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gateway doctor fails when required upstream tools are missing", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-tools-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalGatewayUrl = process.env.PIPELINE_MCP_GATEWAY_URL;
    const originalGatewayToken = process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
    const originalFetch = global.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.PIPELINE_MCP_GATEWAY_URL = "http://127.0.0.1:4483/mcp";
      process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-token";
      global.fetch = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [{ name: "context7_query_docs" }],
            },
          })
        );
      });

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "mcp",
          "gateway",
          "doctor",
        ])
      ).rejects.toThrow("MCP gateway doctor checks failed.");

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("gateway-required-tools");
      expect(output).toContain("missing:");
      expect(output).toContain("backlog");
    } finally {
      log.mockRestore();
      global.fetch = originalFetch;
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("PIPELINE_MCP_GATEWAY_URL", originalGatewayUrl);
      restoreEnv("PIPELINE_MCP_GATEWAY_AUTHORIZATION", originalGatewayToken);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles the current workspace into a complete ToolHive vMCP inventory", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-reconcile-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      mockToolHiveWorkloads(COMPLETE_TOOLHIVE_WORKLOADS);
      process.env.PIPELINE_TARGET_PATH = dir;
      await prepareGatewayWorkspace(runCli, dir);

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "mcp",
        "gateway",
        "reconcile",
      ]);

      expect(mockExeca).toHaveBeenCalledWith(
        "thv",
        expect.arrayContaining(["vmcp", "validate"]),
        expect.objectContaining({ cwd: dir })
      );
      const applyCall = mockExeca.mock.calls.find(
        ([command, args]) =>
          command === "thv" && Array.isArray(args) && args.includes("validate")
      );
      expect(applyCall).toBeDefined();
      const args = applyCall?.[1];
      expect(Array.isArray(args)).toBe(true);
      const filePath = Array.isArray(args) ? args.at(-1) : undefined;
      expect(filePath).toBeTruthy();
      const rendered = readFileSync(filePath as string, "utf8");
      expect(rendered).toContain("name: backlog");
      expect(rendered).toContain("name: context7");
      expect(rendered).toContain("name: fallow");
      expect(rendered).toContain("name: qdrant");
      expect(rendered).toContain(
        "url: http://127.0.0.1/oisin-pipeline-qdrant/mcp/"
      );
      expect(rendered).toContain("name: serena");
      expect(rendered).toContain("name: uidotsh");
      expect(rendered).toContain("groupRef: default");

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("workspace=");
      expect(output).toContain(dir);
      expect(output).not.toMatch(NO_REPO_COPY_RE);
    } finally {
      log.mockRestore();
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts local gateway with ToolHive vMCP for local mode", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-start-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      mockToolHiveWorkloads(COMPLETE_TOOLHIVE_WORKLOADS);
      process.env.PIPELINE_TARGET_PATH = dir;
      await prepareGatewayWorkspace(runCli, dir, { init: true });
      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "mcp",
        "gateway",
        "local-start",
      ]);

      expect(mockExeca).toHaveBeenCalledWith(
        "thv",
        expect.arrayContaining(["vmcp", "validate"]),
        expect.objectContaining({ cwd: dir })
      );
      const validateCall = mockExeca.mock.calls.find(
        ([command, args]) =>
          command === "thv" && Array.isArray(args) && args.includes("validate")
      );
      const validateArgs = validateCall?.[1];
      expect(Array.isArray(validateArgs)).toBe(true);
      const configPath = Array.isArray(validateArgs)
        ? validateArgs.at(-1)
        : undefined;
      expect(configPath).toBe(join(dir, ".pipeline/mcp-gateway/vmcp.yaml"));

      expect(mockExeca).toHaveBeenCalledWith(
        "thv",
        [
          "vmcp",
          "serve",
          "--config",
          join(dir, ".pipeline/mcp-gateway/vmcp.yaml"),
          "--host",
          "127.0.0.1",
          "--port",
          "4483",
        ],
        expect.objectContaining({ cwd: dir })
      );
    } finally {
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses local gateway startup when required ToolHive workloads are missing", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-gateway-start-missing-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      mockToolHiveWorkloads(["oisin-pipeline-qdrant"]);
      process.env.PIPELINE_TARGET_PATH = dir;
      await prepareGatewayWorkspace(runCli, dir, { init: true });

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "mcp",
          "gateway",
          "local-start",
        ])
      ).rejects.toThrow(MISSING_TOOLHIVE_WORKLOAD_RE);

      expect(
        mockExeca.mock.calls.some(
          ([command, args]) =>
            command === "thv" && Array.isArray(args) && args.includes("serve")
        )
      ).toBe(false);
    } finally {
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces YAML runtime failures from pipe", async () => {
    const { pipe } = await import("../src/index");

    const pipelineRunner = vi.fn().mockResolvedValue({
      agentInvocations: [],
      failureDetails: [
        {
          evidence: ["agent boundary node=verify", "missing file"],
          gate: "artifact",
          nodeId: "verify",
          reason: "missing artifact",
        },
      ],
      gates: [],
      hookFailures: [],
      nodes: [
        {
          attempts: 1,
          evidence: ["agent boundary node=verify", "missing file"],
          exitCode: 1,
          nodeId: "verify",
          output: "raw verifier output",
          status: "failed",
        },
      ],
      outcome: "FAIL",
      plan: {
        workflowId: "default",
        parallelBatches: [],
        topologicalOrder: [],
      },
    });

    await expect(
      pipe("ship it", { pipelineRunner, workflow: "default" })
    ).rejects.toThrow(FAILURE_DETAILS_RE);
  });
});
