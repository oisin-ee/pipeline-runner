import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { parsePipelineConfigParts } from "../src/mastra/config.ts";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
  spawnAgent,
} from "../src/mastra/runner.ts";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;

function makeSimpleResult(stdout = "output", exitCode = 0) {
  return Promise.resolve({ stdout, exitCode }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

function parseTestConfig(parts: {
  pipeline: string;
  profiles: string;
  runners: string;
}) {
  return parsePipelineConfigParts(parts);
}

describe("spawnAgent — claude harness", () => {
  it("invokes claude --print -p <prompt> (no contextFile)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("claude output", 0));

    const result = await spawnAgent(
      "claude",
      "researcher",
      "do the thing",
      null,
      "/tmp/wt"
    );

    expect(mockExeca).toHaveBeenCalledWith(
      "claude",
      ["--print", "-p", "do the thing"],
      expect.objectContaining({ cwd: "/tmp/wt" })
    );
    expect(result).toEqual(
      expect.objectContaining({ stdout: "claude output", exitCode: 0 })
    );
  });

  it("prepends loaded context when contextFile is provided (claude argv)", async () => {
    mockExeca.mockReturnValue(makeSimpleResult("ok", 0));

    // Use a fake fs read by writing a temp file.
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    const ctx = join(dir, "ctx.md");
    writeFileSync(ctx, "CONTEXT");

    try {
      await spawnAgent("claude", "researcher", "write code", ctx, "/tmp/wt");
      const args = mockExeca.mock.calls[0][1] as string[];
      const promptIdx = args.indexOf("-p") + 1;
      expect(args[promptIdx]).toBe("CONTEXT\nwrite code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnAgent — codex harness", () => {
  it("invokes codex exec with noninteractive write/approval flags", async () => {
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
        "--sandbox",
        "workspace-write",
        "--config",
        'approval_policy="never"',
        "--skip-git-repo-check",
        "write tests",
        "-C",
        "/tmp/wt",
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
    expect(result.argv).toContain('approval_policy="never"');
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

describe("spawnAgent — pi harness", () => {
  it("invokes pi --print --mode json --no-session with context in prompt", async () => {
    mockExeca.mockReturnValue(makeSimpleResult('{"type":"agent_end"}', 0));
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    const ctx = join(dir, "ctx.md");
    writeFileSync(ctx, "CONTEXT");

    try {
      const result = await spawnAgent(
        "pi",
        "researcher",
        "research this",
        ctx,
        "/tmp/wt"
      );

      expect(mockExeca).toHaveBeenCalledWith(
        "pi",
        ["--print", "--mode", "json", "--no-session", "CONTEXT\nresearch this"],
        expect.objectContaining({ cwd: "/tmp/wt", timeout: 300_000 })
      );

      expect(result.stdout).toContain("agent_end");
      expect(result.exitCode).toBe(0);
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
  claude:
    type: claude
    command: claude
    capabilities:
      native_subagents: true
      output_formats: [text, json]
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text, json, jsonl]
  kimi:
    type: kimi
    command: kimi
    capabilities:
      native_subagents: true
      output_formats: [text, json]
  pi:
    type: pi
    command: pi
    capabilities:
      native_subagents: true
      output_formats: [text, json]
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
  claude-agent: { runner: claude, instructions: { inline: Claude }, output: { format: text } }
  opencode-agent: { runner: opencode, instructions: { inline: OpenCode }, output: { format: json } }
  kimi-agent: { runner: kimi, instructions: { inline: Kimi }, output: { format: text } }
  pi-agent: { runner: pi, instructions: { inline: Pi }, output: { format: json } }
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
    ["claude-agent", "claude", "native", "claude"],
    ["opencode-agent", "opencode", "native", "opencode"],
    ["kimi-agent", "kimi", "native", "kimi"],
    ["pi-agent", "pi", "native", "pi"],
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
    bad.profiles["claude-agent"].output = { format: "jsonl" };

    expect(() =>
      createRunnerLaunchPlan(bad, {
        profileId: "claude-agent",
        nodeId: "node",
        prompt: "do work",
        worktreePath: "/tmp/wt",
      })
    ).toThrow("does not support output format");
  });

  it("hydrates tools, skills, and MCP servers into native runner launch plans", async () => {
    const { readFileSync } = await import("node:fs");
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
  claude:
    type: claude
    command: claude
    capabilities:
      native_subagents: true
      mcp_servers: true
      tools: [read, bash]
      output_formats: [text]
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      mcp_servers: true
      output_formats: [text]
  kimi:
    type: kimi
    command: kimi
    capabilities:
      native_subagents: true
      skills: true
      mcp_servers: true
      output_formats: [text]
  pi:
    type: pi
    command: pi
    capabilities:
      native_subagents: true
      skills: true
      tools: [read, bash]
      output_formats: [text]
`,
      profiles: `
version: 1
skills:
  research:
    path: .agents/skills/research/SKILL.md
mcp_servers:
  docs:
    command: node
    args: ["docs.js"]
    env: { DOCS_TOKEN: test-token }
profiles:
  orchestrator:
    runner: codex
    model: orchestrator-model
    instructions: { inline: Orchestrate }
    skills: [research]
    mcp_servers: [docs]
    tools: [read]
  codex-agent: { runner: codex, model: agent-model, instructions: { inline: Codex }, skills: [research], mcp_servers: [docs] }
  claude-agent: { runner: claude, instructions: { inline: Claude }, mcp_servers: [docs], tools: [read, bash] }
  opencode-agent: { runner: opencode, instructions: { inline: OpenCode }, mcp_servers: [docs] }
  kimi-agent: { runner: kimi, instructions: { inline: Kimi }, skills: [research], mcp_servers: [docs] }
  pi-agent: { runner: pi, instructions: { inline: Pi }, skills: [research], tools: [read, bash] }
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
    expect(codex.args).toContain('mcp_servers.docs.command="node"');
    expect(codex.args).toContain('mcp_servers.docs.args=["docs.js"]');

    const claude = createRunnerLaunchPlan(config, {
      profileId: "claude-agent",
      nodeId: "claude",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    expect(claude.args).toContain("--tools");
    expect(claude.args).toContain("Read,Bash");
    expect(claude.args).toContain("--mcp-config");
    expect(claude.args.join(" ")).toContain('"mcpServers"');

    const opencode = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "opencode",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    expect(opencode.env.OPENCODE_CONFIG).toBeTruthy();
    const opencodeConfig = readFileSync(opencode.env.OPENCODE_CONFIG, "utf8");
    expect(opencodeConfig).toContain('"docs"');
    expect(opencodeConfig).toContain('"environment"');

    const kimi = createRunnerLaunchPlan(config, {
      profileId: "kimi-agent",
      nodeId: "kimi",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    expect(kimi.args).toContain("--skills-dir");
    expect(kimi.args).toContain("/tmp/wt/.agents/skills/research");
    expect(kimi.args).toContain("--mcp-config");

    const pi = createRunnerLaunchPlan(config, {
      profileId: "pi-agent",
      nodeId: "pi",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    expect(pi.args).toContain("--tools");
    expect(pi.args).toContain("read,bash");
    expect(pi.args).toContain("--skill");
    expect(pi.args).toContain("/tmp/wt/.agents/skills/research/SKILL.md");

    const orchestrator = createOrchestratorLaunchPlan(config, {
      nodeId: "orchestrator",
      prompt: "coordinate",
      worktreePath: "/tmp/wt",
    });
    expect(orchestrator.profileId).toBe("orchestrator");
    expect(orchestrator.runnerId).toBe("codex");
    expect(orchestrator.args).toContain("--model");
    expect(orchestrator.args).toContain("orchestrator-model");
    expect(orchestrator.args).toContain('mcp_servers.docs.command="node"');
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
});
