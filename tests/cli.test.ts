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
const QUICK_WORKFLOW_RE = /quick\s+Quick custom workflow/;
const INSPECT_WORKFLOW_RE = /inspect\s+Inspect custom workflow/;
const FAIL_PIPELINE_CONFIG_RE = /FAIL pipeline-config:/;
const FAILED_TO_PARSE_PIPELINE_YAML_RE =
  /Failed to parse .pipeline\/pipeline.yaml/;
const UNKNOWN_ENTRYPOINT_OR_CONFIG_RE =
  /Unknown pipeline entrypoint 'epic'|PIPELINE_CONFIG|Invalid pipeline config|Invalid workflow plan|missing workflow/i;
const PLAN_RESEARCH_RE = /- research kind=agent needs=none/;
const PLAN_PLAN_RE = /- plan kind=agent needs=research/;
const PLAN_IMPLEMENT_RE = /- implement kind=parallel needs=plan/;
const PLAN_MERGE_RE = /- merge kind=builtin needs=implement/;
const PLAN_REVIEW_RE = /- review kind=agent needs=merge/;
const SCHEDULE_GENERATED_PATH_RE = /Schedule generated: (.*schedule\.yaml)/;
const WARNING_RE = /warning/i;
const FAILED_TO_PARSE_PIPELINE_YAML_ESCAPED_RE =
  /Failed to parse \.pipeline\/pipeline\.yaml/;
const MISSING_WORKFLOW_OR_NOT_DECLARED_RE = /missing workflow|not declared/;
const ORIGINAL_MEMORY_MCP_BASIC_AUTH = process.env.MEMORY_MCP_BASIC_AUTH;
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEMORY_MCP_BASIC_AUTH = "test-basic-payload";
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
      installMockSkills(args, (options as { cwd?: string } | undefined)?.cwd);
    }
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }) as any;
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_MEMORY_MCP_BASIC_AUTH === undefined) {
    delete process.env.MEMORY_MCP_BASIC_AUTH;
  } else {
    process.env.MEMORY_MCP_BASIC_AUTH = ORIGINAL_MEMORY_MCP_BASIC_AUTH;
  }
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
  default-start:
    event: workflow.start
    kind: command
    command: [default-start-bin, "{{workflow.id}}", "{{task}}"]
    required: true
  quick-start:
    event: workflow.start
    kind: command
    command: [quick-start-bin, "{{workflow.id}}", "{{task}}"]
    required: true
  validate-start:
    event: workflow.start
    kind: command
    command: [validate-start-bin, "{{workflow.id}}", "{{task}}"]
    required: true
workflows:
  default:
    hooks: [default-start]
    nodes:
      - id: default-node
        kind: command
        command: [default-node-bin]
  quick:
    description: Quick custom workflow
    hooks: [quick-start]
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
    hooks: [validate-start]
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
mcp_servers:
  serena:
    command: serena-mcp
  semgrep:
    command: semgrep-mcp
  github-readonly:
    command: github-mcp
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
    mcp_servers: [serena, semgrep, github-readonly]
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
    const { createSwarmTasks } = await import("../src/backlog.js");

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
    const { createSwarmTasks } = await import("../src/backlog.js");

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
    const { createSwarmTasks } = await import("../src/backlog.js");

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
    const { createSwarmTasks } = await import("../src/backlog.js");

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
    const { markPhase } = await import("../src/backlog.js");

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
    const { planPhaseLifecycle } = await import("../src/backlog.js");

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
    const { planPhaseLifecycle } = await import("../src/backlog.js");

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
    const mod = await import("../src/index.js");
    expect(typeof mod.pipe).toBe("function");
  });

  it("supports direct pipe init invocation from the pipe binary", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-init-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

      expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        "uvx",
        [
          "--python",
          "3.12",
          "mcpm",
          "new",
          "oisin-pipeline-github-readonly",
          "--type",
          "stdio",
          "--force",
          "--command",
          "docker",
          "--args",
          "run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server stdio --read-only",
          "--env",
          `GITHUB_PERSONAL_ACCESS_TOKEN=$${"{GITHUB_PERSONAL_ACCESS_TOKEN}"}`,
        ],
        expect.objectContaining({
          cwd: dir,
          env: expect.objectContaining({
            MCPM_NON_INTERACTIVE: "true",
          }),
        })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        "uvx",
        [
          "--python",
          "3.12",
          "mcpm",
          "new",
          "oisin-pipeline-semgrep",
          "--type",
          "stdio",
          "--force",
          "--command",
          "docker",
          "--args",
          "run -i --rm ghcr.io/semgrep/mcp -t stdio",
        ],
        expect.objectContaining({
          cwd: dir,
          env: expect.objectContaining({
            MCPM_NON_INTERACTIVE: "true",
          }),
        })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        "uvx",
        [
          "--python",
          "3.12",
          "mcpm",
          "new",
          "oisin-pipeline-qdrant",
          "--type",
          "remote",
          "--force",
          "--url",
          "https://memory-mcp.momokaya.ee/mcp/",
          "--headers",
          "Authorization=Basic test-basic-payload",
        ],
        expect.objectContaining({
          cwd: dir,
          env: expect.objectContaining({
            MCPM_NON_INTERACTIVE: "true",
          }),
        })
      );
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts resolved MCP authorization headers from MCPM registration failures", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-init-redacted-mcp-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.MEMORY_MCP_BASIC_AUTH = "memory-basic-payload";
      mockExeca.mockImplementation(((
        command: string,
        args?: string[],
        options?: { cwd?: string }
      ) => {
        if (args?.includes("oisin-pipeline-qdrant")) {
          return Promise.reject({
            shortMessage:
              "Command failed: uvx --python 3.12 mcpm new oisin-pipeline-qdrant --headers Authorization=Basic memory-basic-payload",
            stderr: "remote rejected Authorization=Basic memory-basic-payload",
            stdout: "Basic memory-basic-payload",
          });
        }
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

      let message = "";
      try {
        await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      } catch (err) {
        message = String((err as Error).message ?? err);
      }

      expect(message).toContain("Authorization=[REDACTED]");
      expect(message).not.toContain("memory-basic-payload");
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips only Qdrant MCPM registration when memory credentials are missing", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-init-missing-qdrant-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      delete process.env.MEMORY_MCP_BASIC_AUTH;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);

      expect(
        mockExeca.mock.calls.some(
          ([command, args]) =>
            command === "uvx" &&
            Array.isArray(args) &&
            args.includes("oisin-pipeline-qdrant")
        )
      ).toBe(false);
      expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
      expect(existsSync(join(dir, ".pipeline", "pipeline.yaml"))).toBe(true);
      expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toContain(
        "oisin-pipeline-qdrant"
      );
      expect(
        readFileSync(join(dir, ".pipeline", "profiles.yaml"), "utf8")
      ).toContain("qdrant");
      expect(
        readFileSync(join(dir, ".pipeline", "pipeline.yaml"), "utf8")
      ).toContain("learn");
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(
        "Skipped MCPM registration for oisin-pipeline-qdrant"
      );
      expect(output).toContain("MEMORY_MCP_BASIC_AUTH");
    } finally {
      log.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs host resources into PIPELINE_TARGET_PATH", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-install-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "install-commands",
        "--host",
        "opencode",
      ]);

      expect(existsSync(join(dir, ".opencode", "commands", "pipe.md"))).toBe(
        true
      );
      expect(
        existsSync(join(process.cwd(), ".opencode", "commands", "pipe.md"))
      ).toBe(true);
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects relative Node entrypoint paths as CLI executions", async () => {
    const { isCliEntrypoint } = await import("../src/index.js");
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
    const { pipe } = await import("../src/index.js");
    await expect(pipe("")).rejects.toThrow(DESCRIPTION_RE);
  });

  it("runs the YAML runtime through the pipe function", async () => {
    const { pipe } = await import("../src/index.js");
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
    const { pipe } = await import("../src/index.js");
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

  it("generates a schedule artifact and stops for scheduled pipe entrypoints", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-schedule-plan-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeScheduledCliConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;
      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `
version: 1
kind: pipeline-schedule
schedule_id: run-cli
source_entrypoint: pipe
task: ship it
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: inspect
        kind: command
        command: [inspect-bin]
`,
      } as any);

      await runCli(["node", "/repo/node_modules/.bin/pipe", "ship", "it"]);

      const output = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(output).toContain("Schedule generated:");
      expect(output).toContain("pipe run --schedule");
      expect(execaCommands()).toEqual(["scheduled-runner"]);
      const schedulePath = output.match(SCHEDULE_GENERATED_PATH_RE)?.at(1);
      expect(schedulePath).toBeDefined();
      expect(existsSync(schedulePath ?? "")).toBe(true);
      expect(readFileSync(schedulePath ?? "", "utf8")).toContain(
        "kind: pipeline-schedule"
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes an approved schedule artifact via run --schedule", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-schedule-run-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeScheduledCliConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;
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
      const output = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(output).toContain("Workflow: schedule-approved-a-root");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates and explains an approved schedule artifact", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-schedule-inspect-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeScheduledCliConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;
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

      const output = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(output).toContain("OK: schedule-approved-b-root (1 nodes)");
      expect(output).toContain("Workflow: schedule-approved-b-root");
      expect(output).toContain("- scheduled kind=command needs=none");
      expect(output).not.toContain("Unrecognized key: task_context");
      expect(execaCommands()).toEqual([]);
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispatches pipe entrypoint subcommands to the configured entrypoint workflow", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-entrypoint-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeCliEntrypointConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "quick",
        "ship",
        "it",
      ]);

      expect(mockExeca).toHaveBeenCalledWith(
        "quick-start-bin",
        ["quick", "ship it"],
        expect.objectContaining({ cwd: dir })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        "quick-node-bin",
        [],
        expect.objectContaining({ cwd: dir })
      );
      expect(execaCommands()).not.toContain("default-start-bin");
      expect(execaCommands()).not.toContain("default-node-bin");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists configured entrypoint subcommands with descriptions in pipe help", async () => {
    const { createCliProgram } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-entrypoint-help-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      writeCliEntrypointConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;

      const help = createCliProgram().helpInformation();

      expect(help).toMatch(QUICK_WORKFLOW_RE);
      expect(help).toMatch(INSPECT_WORKFLOW_RE);
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets builtin collision commands win over configured entrypoints", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-collision-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      writeCliEntrypointConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

      const output = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(output).toContain("OK: default");
      expect(output).not.toContain("validate-entrypoint");
      expect(execaCommands()).not.toContain("validate-start-bin");
      expect(execaCommands()).not.toContain("validate-entrypoint-bin");
    } finally {
      log.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports the collision escape hatch via pipe run --entrypoint", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-collision-run-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeCliEntrypointConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "run",
        "--entrypoint",
        "validate",
        "ship",
        "collision",
      ]);

      expect(mockExeca).toHaveBeenCalledWith(
        "validate-start-bin",
        ["validate-entrypoint", "ship collision"],
        expect.objectContaining({ cwd: dir })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        "validate-entrypoint-bin",
        [],
        expect.objectContaining({ cwd: dir })
      );
      expect(execaCommands()).not.toContain("default-start-bin");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps pipe init and doctor bootstrap commands reachable without config", async () => {
    const { runCli } = await import("../src/index.js");
    const initDir = mkdtempSync(join(tmpdir(), "pipeline-cli-bootstrap-init-"));
    const doctorDir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-bootstrap-doctor-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = initDir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      expect(existsSync(join(initDir, ".pipeline", "pipeline.yaml"))).toBe(
        true
      );

      process.env.PIPELINE_TARGET_PATH = doctorDir;
      await expect(
        runCli(["node", "/repo/node_modules/.bin/pipe", "doctor"])
      ).rejects.toThrow("Doctor checks failed.");
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toMatch(FAIL_PIPELINE_CONFIG_RE);
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

  it("rejects malformed pipeline config for non-bootstrap invocations before treating args as task text", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-malformed-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      writeMalformedCliConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;

      await expect(
        runCli(["node", "/repo/node_modules/.bin/pipe", "quick", "ship", "it"])
      ).rejects.toThrow(FAILED_TO_PARSE_PIPELINE_YAML_RE);
      expect(execaCommands()).toEqual([]);
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when pipe run is invoked without .pipeline/pipeline.yaml", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-missing-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      await expect(
        runCli(["node", "/repo/node_modules/.bin/pipe", "ship it"])
      ).rejects.toThrow("Missing required pipeline config");
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows init to repair a partial pipeline scaffold", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-partial-init-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      writeCliProjectFile(
        dir,
        ".pipeline/pipeline.yaml",
        "version: 1\ndefault_workflow: default\nworkflows: {}\n"
      );
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "init",
        "--overwrite",
      ]);

      expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(true);
      expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(true);
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("Initialized pipeline scaffold:");
    } finally {
      log.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates and explains the initialized YAML plan", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-plan-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);
      await runCli(["node", "/repo/node_modules/.bin/pipe", "explain-plan"]);
      await runCli(["node", "/repo/node_modules/.bin/pipe", "doctor"]);

      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("Workflow: default");
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("strategy=native");
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("Doctor: PASS");
    } finally {
      log.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the epic-drain workflow without treating current warnings as fatal", async () => {
    const { runCli } = await import("../src/index.js");
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let thrown: unknown;

    try {
      process.env.PIPELINE_TARGET_PATH = process.cwd();
      try {
        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "validate",
          "--workflow",
          "epic-drain",
        ]);
      } catch (err) {
        thrown = err;
      }

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      const stdout = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      const failureText = [
        thrown instanceof Error ? thrown.message : String(thrown ?? ""),
        stderr,
        stdout,
      ].join("\n");

      expect(failureText).not.toMatch(UNKNOWN_ENTRYPOINT_OR_CONFIG_RE);
      expect(thrown).toBeUndefined();
      expect(stderr).toContain(
        "WARN entrypoint-shadowed: entrypoint 'pipe' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint pipe ...'"
      );
      expect(stdout).toContain("OK: epic-drain");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
    }
  });

  it("explains the epic-drain workflow topology including parallel implementation children", async () => {
    const { runCli } = await import("../src/index.js");
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let thrown: unknown;

    try {
      process.env.PIPELINE_TARGET_PATH = process.cwd();
      try {
        await runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "explain-plan",
          "--workflow",
          "epic-drain",
        ]);
      } catch (err) {
        thrown = err;
      }

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      const stdout = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      const failureText = [
        thrown instanceof Error ? thrown.message : String(thrown ?? ""),
        stderr,
        stdout,
      ].join("\n");

      expect(failureText).not.toMatch(UNKNOWN_ENTRYPOINT_OR_CONFIG_RE);
      expect(thrown).toBeUndefined();
      expect(stdout).toContain("Workflow: epic-drain");
      expect(stdout).toContain(
        "Batches: [research] -> [plan] -> [implement] -> [merge] -> [review]"
      );
      expect(stdout).toContain(
        "implement(parallel: test, frontend, backend, k8s)"
      );
      expect(stdout).toMatch(PLAN_RESEARCH_RE);
      expect(stdout).toMatch(PLAN_PLAN_RE);
      expect(stdout).toMatch(PLAN_IMPLEMENT_RE);
      expect(stdout).toMatch(PLAN_MERGE_RE);
      expect(stdout).toMatch(PLAN_REVIEW_RE);
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
    }
  });

  it("validate emits WARN entrypoint-shadowed when configured entrypoints collide with builtins", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-entrypoint-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeCliValidateLintConfig(dir, {
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
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).toContain(
        "WARN entrypoint-shadowed: entrypoint 'validate' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint validate ...'"
      );
      expect(stderr).toContain(
        "WARN entrypoint-shadowed: entrypoint 'pipe' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint pipe ...'"
      );
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate emits WARN missing-file-reference for optional asset paths without failing", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-missing-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
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
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).toContain(
        "WARN missing-file-reference: skills.missing-skill.path references missing file '.agents/skills/missing/SKILL.md'"
      );
      expect(stderr).toContain(
        "WARN missing-file-reference: profiles.orchestrator.instructions.path references missing file '.pipeline/prompts/missing.md'"
      );
      expect(stderr).toContain(
        "WARN missing-file-reference: profiles.orchestrator.output.schema_path references missing file '.pipeline/schemas/missing.schema.json'"
      );
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate does not warn about missing epic-router asset files once the bundle exists", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-epic-router-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
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
mcp_servers:
  backlog:
    command: backlog-mcp
  github-readonly:
    command: github-mcp
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
    mcp_servers: [backlog, github-readonly]
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
          writeCliProjectFile(dir, assetPath, readFileSync(sourcePath, "utf8"));
        }
      }
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).not.toContain(
        "profiles.pipeline-epic-router.instructions.path references missing file '.pipeline/prompts/epic-router.md'"
      );
      expect(stderr).not.toContain(
        "profiles.pipeline-epic-router.output.schema_path references missing file '.pipeline/schemas/epic-plan.schema.json'"
      );
      expect(stderr).not.toContain("WARN missing-file-reference");
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate --strict emits no thermo-nuclear review missing-file-reference warning when the skill is present", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-lint-thermo-review-present-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeThermoNuclearReviewValidateFixture(dir, { includeSkill: true });
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "validate",
        "--strict",
      ]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).not.toContain("WARN missing-file-reference");
      expect(stderr).not.toContain(
        "skills.thermo-nuclear-code-quality-review.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'"
      );
      expect(stderr).not.toContain(
        "profiles.pipeline-thermo-nuclear-reviewer.instructions.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'"
      );
      expect(stderr).not.toContain(
        "profiles.pipeline-thermo-nuclear-reviewer.output.schema_path references missing file '.pipeline/schemas/review.schema.json'"
      );
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate emits thermo-nuclear review missing-file-reference warnings when the skill file is absent", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-lint-thermo-review-missing-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeThermoNuclearReviewValidateFixture(dir, { includeSkill: false });
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      const missingFileWarnings = stderr
        .split("\n")
        .filter((line) => line.includes("WARN missing-file-reference"));
      expect(missingFileWarnings).toEqual([
        "WARN missing-file-reference: skills.thermo-nuclear-code-quality-review.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'",
        "WARN missing-file-reference: profiles.pipeline-thermo-nuclear-reviewer.instructions.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'",
      ]);
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate emits WARN singleton-parallel for a parallel node with one child", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-parallel-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeCliValidateLintConfig(dir, {
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
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).toContain(
        "WARN singleton-parallel: node 'fanout' is a parallel container with only one child; remove the wrapper"
      );
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate emits WARN worktree-root-style for workflow node roots outside pipeline run directories", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-worktree-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeCliValidateLintConfig(dir, {
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
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli(["node", "/repo/node_modules/.bin/pipe", "validate"]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).toContain(
        `WARN worktree-root-style: node 'nested' worktree_root 'tmp/pipeline-runs/$${"{runId}"}/$${"{nodeId}"}' is outside the suggested .pipeline/runs/ root; this is a style nudge, not an error`
      );
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate --strict rejects when lint warnings exist and still emits WARN output", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-strict-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
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
      process.env.PIPELINE_TARGET_PATH = dir;

      await expect(
        runCli(["node", "/repo/node_modules/.bin/pipe", "validate", "--strict"])
      ).rejects.toThrow(WARNING_RE);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).toContain(
        "WARN entrypoint-shadowed: entrypoint 'validate' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint validate ...'"
      );
    } finally {
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate --no-lint skips WARN output and succeeds schema and plan validation only", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-disabled-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
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
      process.env.PIPELINE_TARGET_PATH = dir;

      await runCli([
        "node",
        "/repo/node_modules/.bin/pipe",
        "validate",
        "--no-lint",
      ]);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).not.toContain("WARN ");
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("OK: default");
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate schema errors still reject regardless of --strict and --no-lint", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-schema-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      writeMalformedCliConfig(dir);
      process.env.PIPELINE_TARGET_PATH = dir;

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "validate",
          "--strict",
          "--no-lint",
        ])
      ).rejects.toThrow(FAILED_TO_PARSE_PIPELINE_YAML_ESCAPED_RE);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).not.toContain("WARN ");
    } finally {
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate treats undefined workflow targets as config-level failures rather than lint warnings", async () => {
    const { runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-lint-workflow-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
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
      process.env.PIPELINE_TARGET_PATH = dir;

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/pipe",
          "validate",
          "--no-lint",
        ])
      ).rejects.toThrow(MISSING_WORKFLOW_OR_NOT_DECLARED_RE);

      const stderr = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(stderr).not.toContain("WARN ");
    } finally {
      error.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor reports missing prerequisites", async () => {
    const { runDoctor, runCli } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-doctor-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      await runCli(["node", "/repo/node_modules/.bin/pipe", "init"]);
      mockExeca.mockImplementation(((command: string) => {
        if (command === "uvx") {
          return Promise.reject({ shortMessage: "uvx mcpm failed" });
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      }) as any);

      const result = await runDoctor(dir);

      expect(result.passed).toBe(false);
      expect(result.checks).toContainEqual({
        detail: "uvx mcpm failed",
        name: "uvx",
        passed: false,
      });
      expect(result.checks).toContainEqual({
        detail: "uvx mcpm failed",
        name: "mcpm-cli",
        passed: false,
      });
    } finally {
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces YAML runtime failures from pipe", async () => {
    const { pipe } = await import("../src/index.js");

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
