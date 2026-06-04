import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { parsePipelineConfigParts } from "../src/config.ts";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
  spawnAgent,
} from "../src/runner.ts";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

function makeSimpleResult(stdout = "output", exitCode = 0) {
  return Promise.resolve({ stdout, exitCode }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PIPELINE_MCP_GATEWAY_URL = "http://127.0.0.1:8787/mcp";
  process.env.MEMORY_MCP_BASIC_AUTH = "test-gateway-token";
});

function parseTestConfig(parts: {
  pipeline: string;
  profiles: string;
  runners: string;
}) {
  return parsePipelineConfigParts(parts);
}

describe("spawnAgent — codex harness", () => {
  it("invokes codex exec with bypass approvals and sandbox flag", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("codex output", 0));

    const result = await spawnAgent(
      "codex",
      "test-writer",
      "write tests",
      null,
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--json",
        "-C",
        "/tmp/wt",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "write tests",
      ],
      expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
    );
    expect(result).toEqual(
      expect.objectContaining({ stdout: "codex output", exitCode: 0 })
    );
  });

  it("returns timeout diagnostics instead of losing subprocess evidence", async () => {
    mockExeca.mockRejectedValueOnce(
      Object.assign(new Error("timed out"), {
        exitCode: undefined,
        stdout: "partial output",
        stderr: "permission prompt",
        timedOut: true,
      })
    );

    const result = await spawnAgent(
      "codex",
      "test-writer",
      "write tests",
      null,
      "/tmp/wt"
    );

    expect(result).toEqual(
      expect.objectContaining({
        exitCode: 1,
        stderr: "permission prompt",
        stdout: "partial output",
        timedOut: true,
      })
    );
    expect(result.argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(result.argv).not.toContain('approval_policy="never"');
  });
});

describe("spawnAgent — opencode harness", () => {
  it("invokes opencode run --format json --dir <worktree> <prompt> (no contextFile)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));

    await spawnAgent("opencode", "verifier", "verify things", null, "/tmp/wt");

    expect(mockExeca).toHaveBeenCalledWith(
      "opencode",
      [
        "run",
        "--format",
        "json",
        "--model",
        "opencode/deepseek-v4-flash-free",
        "--dangerously-skip-permissions",
        "--dir",
        "/tmp/wt",
        "verify things",
      ],
      expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
    );
  });

  it("appends --file <contextFile> when provided", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));

    await spawnAgent(
      "opencode",
      "verifier",
      "verify things",
      "/tmp/ctx.md",
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "opencode",
      [
        "run",
        "--format",
        "json",
        "--model",
        "opencode/deepseek-v4-flash-free",
        "--dangerously-skip-permissions",
        "--dir",
        "/tmp/wt",
        "verify things",
        "--file",
        "/tmp/ctx.md",
      ],
      expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
    );
  });

  it("adds git info excludes before opencode runs", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("opencode output", 0));
    const { mkdirSync, readFileSync, rmSync, writeFileSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await import("node:fs").then(({ mkdtempSync }) =>
      mkdtempSync(join(tmpdir(), "runner-opencode-"))
    );

    try {
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      writeFileSync(join(dir, ".git", "info", "exclude"), "# existing\n");

      await spawnAgent("opencode", "verifier", "verify things", null, dir);

      const exclude = readFileSync(join(dir, ".git", "info", "exclude"), {
        encoding: "utf8",
      });
      expect(exclude).toContain("node_modules/");
      expect(exclude).toContain(".opencode/node_modules/");
      expect(exclude).toContain(".mastra/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createRunnerLaunchPlan", () => {
  const CONFIG = parseTestConfig({
    runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    model: runner-codex
    capabilities:
      native_subagents: true
      output_formats: [text, json, jsonl, json_schema]
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text, json, jsonl]
  shell:
    type: command
    command: node
    args: ["-e", "console.log({{prompt}})", "{{cwd}}"]
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    model: orchestrator-codex
    instructions: { inline: Orchestrate }
    tools: []
  codex-agent: { runner: codex, model: agent-codex, instructions: { inline: Codex }, output: { format: jsonl } }
  opencode-agent: { runner: opencode, instructions: { inline: OpenCode }, output: { format: json } }
  command-agent: { runner: shell, instructions: { inline: Shell }, output: { format: text } }
`,
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - { id: run, kind: agent, profile: codex-agent }
`,
  });

  it.each([
    ["codex-agent", "codex", "native", "codex"],
    ["opencode-agent", "opencode", "native", "opencode"],
    ["command-agent", "shell", "subprocess", "node"],
  ])("creates a deterministic launch plan for %s", (profileId, runnerId, strategy, command) => {
    const plan = createRunnerLaunchPlan(CONFIG, {
      profileId,
      nodeId: "node",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });

    expect(plan).toEqual(
      expect.objectContaining({
        command,
        cwd: "/tmp/wt",
        nodeId: "node",
        profileId,
        runnerId,
        strategy,
      })
    );
    expect(plan.args.join(" ")).toContain(
      profileId === "command-agent" ? "/tmp/wt" : "do work"
    );
  });

  it("rejects unsupported output contracts before execution", () => {
    const bad = structuredClone(CONFIG);
    bad.profiles["opencode-agent"].output = { format: "json_schema" };

    expect(() =>
      createRunnerLaunchPlan(bad, {
        profileId: "opencode-agent",
        nodeId: "node",
        prompt: "do work",
        worktreePath: "/tmp/wt",
      })
    ).toThrow("does not support output format");
  });

  it("hydrates tools and skills without injecting MCP into native runner launch plans", () => {
    const config = parseTestConfig({
      runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    model: runner-codex
    capabilities:
      native_subagents: true
      skills: true
      mcp_servers: true
      tools: [read]
      output_formats: [text]
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      mcp_servers: true
      output_formats: [text]
`,
      profiles: `
version: 1
skills:
  research:
    path: .agents/skills/research/SKILL.md
mcp_gateway:
  provider: toolhive
  mode: hosted
  url_env: PIPELINE_MCP_GATEWAY_URL
  token_env: MEMORY_MCP_BASIC_AUTH
profiles:
  orchestrator:
    runner: codex
    model: orchestrator-model
    instructions: { inline: Orchestrate }
    skills: [research]
    mcp_servers: [pipeline-gateway]
    tools: [read]
  codex-agent: { runner: codex, model: agent-model, instructions: { inline: Codex }, skills: [research], mcp_servers: [pipeline-gateway] }
  opencode-agent: { runner: opencode, instructions: { inline: OpenCode }, mcp_servers: [pipeline-gateway] }
`,
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - { id: run, kind: agent, profile: codex-agent }
`,
    });

    const codex = createRunnerLaunchPlan(config, {
      profileId: "codex-agent",
      nodeId: "codex",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    expect(codex.args).toContain("--model");
    expect(codex.args).toContain("agent-model");
    expect(codex.args).toContain("--ignore-user-config");
    expect(codex.args).toContain(
      'skills.config=[{ enabled = true, path = "/tmp/wt/.agents/skills/research/SKILL.md" }]'
    );
    expect(codex.args.join("\n")).not.toContain("mcp_servers.");
    expect(codex.args.join("\n")).not.toContain("docs.js");
    expect(codex.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codex.args).not.toContain("--sandbox");
    expect(codex.args).not.toContain('approval_policy="never"');

    const opencode = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "opencode",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    expect(opencode.env).toEqual({});
    expect(opencode.args.join("\n")).not.toContain("mcp_servers.");

    const orchestrator = createOrchestratorLaunchPlan(config, {
      nodeId: "orchestrator",
      prompt: "coordinate",
      worktreePath: "/tmp/wt",
    });
    expect(orchestrator.profileId).toBe("orchestrator");
    expect(orchestrator.runnerId).toBe("codex");
    expect(orchestrator.args).toContain("--model");
    expect(orchestrator.args).toContain("orchestrator-model");
    expect(orchestrator.args).toContain("--ignore-user-config");
    expect(orchestrator.args).toContain(
      'skills.config=[{ enabled = true, path = "/tmp/wt/.agents/skills/research/SKILL.md" }]'
    );
    expect(orchestrator.args.join("\n")).not.toContain("mcp_servers.");
  });

  it("does not project any MCP server names into native runner launch plans", () => {
    const project = "/tmp/pipeline-runner-mcp";
    const config = parsePipelineConfigParts(
      {
        runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      mcp_servers: true
      output_formats: [text]
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      mcp_servers: true
      output_formats: [text]
`,
        profiles: `
version: 1
mcp_gateway:
  provider: toolhive
  mode: hosted
  url_env: PIPELINE_MCP_GATEWAY_URL
  token_env: MEMORY_MCP_BASIC_AUTH
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    mcp_servers: [pipeline-gateway]
  codex-agent:
    runner: codex
    instructions: { inline: Codex }
    mcp_servers: [pipeline-gateway]
  opencode-agent:
    runner: opencode
    instructions: { inline: OpenCode }
    mcp_servers: [pipeline-gateway]
`,
        pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - { id: run, kind: agent, profile: codex-agent }
`,
      },
      project
    );

    const codex = createRunnerLaunchPlan(config, {
      profileId: "codex-agent",
      nodeId: "codex",
      prompt: "do work",
      worktreePath: project,
    });
    expect(codex.args.join("\n")).not.toContain("mcp_servers.pipeline-gateway");
    expect(codex.args.join("\n")).not.toContain("mcp_servers.serena");
    expect(codex.args.join("\n")).not.toContain(
      "git+https://github.com/oraios/serena"
    );

    const opencode = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "opencode",
      prompt: "do work",
      worktreePath: project,
    });
    expect(opencode.env).toEqual({});
    expect(opencode.args.join("\n")).not.toContain("mcp_servers.");
  });

  it("falls back from actor model to runner model for launch plans", () => {
    const config = structuredClone(CONFIG);
    config.profiles["codex-agent"].model = undefined;
    config.profiles.orchestrator.model = undefined;

    const agent = createRunnerLaunchPlan(config, {
      profileId: "codex-agent",
      nodeId: "agent",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    const orchestrator = createOrchestratorLaunchPlan(config, {
      nodeId: "orchestrator",
      prompt: "coordinate",
      worktreePath: "/tmp/wt",
    });

    expect(agent.args).toContain("runner-codex");
    expect(orchestrator.args).toContain("runner-codex");
  });

  it("uses Codex bypass mode for read-only profiles", () => {
    const config = structuredClone(CONFIG);
    config.profiles["codex-agent"].filesystem = { mode: "read-only" };

    const plan = createRunnerLaunchPlan(config, {
      profileId: "codex-agent",
      nodeId: "node",
      prompt: "inspect",
      worktreePath: "/tmp/wt",
    });

    expect(plan.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(plan.args).not.toContain("--sandbox");
    expect(plan.args).not.toContain("read-only");
  });
});
