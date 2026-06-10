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
import { normalizeRunnerOutput } from "../src/runner-output.ts";
import { opencodeCliRuntimeAdapter } from "../src/runtime/opencode-adapter.ts";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
function makeSimpleResult(stdout = "output", exitCode = 0) {
  return Promise.resolve({ stdout, exitCode }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PIPELINE_AGENT_TIMEOUT_MS;
  process.env.PIPELINE_MCP_GATEWAY_URL = "http://127.0.0.1:8787/mcp";
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "test-gateway-token";
});

function parseTestConfig(parts: {
  pipeline: string;
  profiles: string;
  runners: string;
}) {
  return parsePipelineConfigParts(parts);
}

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
        "openai/gpt-5.5",
        "--dangerously-skip-permissions",
        "--dir",
        "/tmp/wt",
        "verify things",
      ],
      expect.not.objectContaining({ timeout: expect.any(Number) })
    );
    expect(mockExeca.mock.calls[0][2]).toEqual(
      expect.objectContaining({ cwd: "/tmp/wt" })
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
        "openai/gpt-5.5",
        "--dangerously-skip-permissions",
        "--dir",
        "/tmp/wt",
        "verify things",
        "--file",
        "/tmp/ctx.md",
      ],
      expect.not.objectContaining({ timeout: expect.any(Number) })
    );
    expect(mockExeca.mock.calls[0][2]).toEqual(
      expect.objectContaining({ cwd: "/tmp/wt" })
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
  opencode:
    type: opencode
    command: opencode
    model: openai/gpt-5.5
    capabilities:
      native_subagents: true
      output_formats: [text, json, jsonl, json_schema]
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
    runner: opencode
    model: orchestrator-model
    instructions: { inline: Orchestrate }
    tools: []
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
      - { id: run, kind: agent, profile: opencode-agent }
`,
  });

  it.each([
    ["opencode-agent", "opencode", "opencode"],
    ["command-agent", "shell", "node"],
  ])("creates a deterministic launch plan for %s", (profileId, runnerId, command) => {
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
      })
    );
    expect(plan.args.join(" ")).toContain(
      profileId === "command-agent" ? "/tmp/wt" : "do work"
    );
  });

  it("uses a profile timeout for native runner launch plans", () => {
    const config = structuredClone(CONFIG);
    config.profiles["opencode-agent"].timeout_ms = 900_000;

    const plan = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "research-current-club",
      prompt: "research current club",
      worktreePath: "/tmp/wt",
    });

    expect(plan).toMatchObject({
      nodeId: "research-current-club",
      profileId: "opencode-agent",
      runnerId: "opencode",
      timeoutMs: 900_000,
    });
  });

  it("does not invent a native runner timeout when config and env omit one", () => {
    const plan = createRunnerLaunchPlan(CONFIG, {
      profileId: "opencode-agent",
      nodeId: "research-current-club",
      prompt: "research current club",
      worktreePath: "/tmp/wt",
    });

    expect(plan.timeoutMs).toBeUndefined();
  });

  it("keeps the OpenCode CLI adapter launch plan behavior-compatible", () => {
    const plan = createRunnerLaunchPlan(CONFIG, {
      contextFile: "/tmp/context.md",
      profileId: "opencode-agent",
      nodeId: "opencode-node",
      prompt: "do OpenCode work",
      worktreePath: "/tmp/wt",
    });

    const launch = opencodeCliRuntimeAdapter.launch(plan);
    const metadata = opencodeCliRuntimeAdapter.sessionMetadata(plan);

    expect(launch).toEqual({
      args: [
        "run",
        "--format",
        "json",
        "--model",
        "openai/gpt-5.5",
        "--dangerously-skip-permissions",
        "--dir",
        "/tmp/wt",
        "do OpenCode work",
        "--file",
        "/tmp/context.md",
      ],
      command: "opencode",
      cwd: "/tmp/wt",
      env: {},
      timeoutMs: undefined,
    });
    expect(metadata).toEqual({
      adapterId: "opencode-cli-subprocess",
      continuationApi: "unavailable",
      nodeId: "opencode-node",
      outputFormat: "json",
      pluginEvents: "project-local",
      profileId: "opencode-agent",
      runnerId: "opencode",
      sessionInspectionApi: "unavailable",
      worktreePath: "/tmp/wt",
    });
  });

  it("normalizes OpenCode JSON event output through the runtime adapter", () => {
    const plan = createRunnerLaunchPlan(CONFIG, {
      profileId: "opencode-agent",
      nodeId: "opencode-node",
      prompt: "do OpenCode work",
      worktreePath: "/tmp/wt",
    });
    const stdout = [
      "debug line",
      JSON.stringify({ part: { type: "text", text: "first" } }),
      JSON.stringify({ part: { type: "text", text: "final" } }),
    ].join("\n");

    expect(opencodeCliRuntimeAdapter.outputCandidates(stdout)).toEqual([
      {
        evidence: "normalized runner output from opencode JSON events",
        output: "first",
      },
      {
        evidence: "normalized runner output from opencode JSON events",
        output: "final",
      },
    ]);
    expect(normalizeRunnerOutput(plan, stdout)).toEqual({
      evidence: ["normalized runner output from opencode JSON events"],
      output: "final",
    });
  });

  it("uses PIPELINE_AGENT_TIMEOUT_MS when explicitly configured in the environment", () => {
    process.env.PIPELINE_AGENT_TIMEOUT_MS = "123456";

    const plan = createRunnerLaunchPlan(CONFIG, {
      profileId: "opencode-agent",
      nodeId: "research-current-club",
      prompt: "research current club",
      worktreePath: "/tmp/wt",
    });

    expect(plan.timeoutMs).toBe(123_456);
  });

  it("rejects unsupported output contracts before execution", () => {
    const bad = structuredClone(CONFIG);
    bad.runners.opencode.capabilities.output_formats = ["text"];
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
  opencode:
    type: opencode
    command: opencode
    model: openai/gpt-5.5
    capabilities:
      native_subagents: true
      skills: true
      mcp_servers: true
      tools: [read]
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
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: opencode
    model: orchestrator-model
    instructions: { inline: Orchestrate }
    skills: [research]
    mcp_servers: [pipeline-gateway]
    tools: [read]
  opencode-agent: { runner: opencode, model: agent-model, instructions: { inline: OpenCode }, skills: [research], mcp_servers: [pipeline-gateway] }
`,
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - { id: run, kind: agent, profile: opencode-agent }
`,
    });

    const agent = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "agent",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    expect(agent.args).toContain("--model");
    expect(agent.args).toContain("agent-model");
    expect(agent.args.join("\n")).not.toContain("mcp_servers.");
    expect(agent.args.join("\n")).not.toContain("docs.js");
    expect(agent.args).toContain("--dangerously-skip-permissions");
    expect(agent.args).not.toContain("--sandbox");

    const orchestrator = createOrchestratorLaunchPlan(config, {
      nodeId: "orchestrator",
      prompt: "coordinate",
      worktreePath: "/tmp/wt",
    });
    expect(orchestrator.profileId).toBe("orchestrator");
    expect(orchestrator.runnerId).toBe("opencode");
    expect(orchestrator.args).toContain("--model");
    expect(orchestrator.args).toContain("orchestrator-model");
    expect(orchestrator.args.join("\n")).not.toContain("mcp_servers.");
  });

  it("does not project any MCP server names into native runner launch plans", () => {
    const project = "/tmp/pipeline-runner-mcp";
    const config = parsePipelineConfigParts(
      {
        runners: `
version: 1
runners:
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
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
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
      - { id: run, kind: agent, profile: opencode-agent }
`,
      },
      project
    );

    const agent = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "agent",
      prompt: "do work",
      worktreePath: project,
    });
    expect(agent.args.join("\n")).not.toContain("mcp_servers.pipeline-gateway");
    expect(agent.args.join("\n")).not.toContain("mcp_servers.serena");
    expect(agent.args.join("\n")).not.toContain(
      "git+https://github.com/oraios/serena"
    );
  });

  it("falls back from actor model to runner model for launch plans", () => {
    const config = structuredClone(CONFIG);
    config.profiles["opencode-agent"].model = undefined;
    config.profiles.orchestrator.model = undefined;

    const agent = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "agent",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    const orchestrator = createOrchestratorLaunchPlan(config, {
      nodeId: "orchestrator",
      prompt: "coordinate",
      worktreePath: "/tmp/wt",
    });

    expect(agent.args).toContain(config.runners.opencode.model);
    expect(orchestrator.args).toContain(config.runners.opencode.model);
  });

  it("uses OpenCode permission bypass mode for read-only profiles", () => {
    const config = structuredClone(CONFIG);
    config.profiles["opencode-agent"].filesystem = { mode: "read-only" };

    const plan = createRunnerLaunchPlan(config, {
      profileId: "opencode-agent",
      nodeId: "node",
      prompt: "inspect",
      worktreePath: "/tmp/wt",
    });

    expect(plan.args).toContain("--dangerously-skip-permissions");
    expect(plan.args).not.toContain("--sandbox");
    expect(plan.args).not.toContain("read-only");
  });
});
