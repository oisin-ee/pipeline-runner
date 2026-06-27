import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { parsePipelineConfigParts } from "../src/config.ts";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
} from "../src/runner";
import { runLaunchPlan } from "../src/runner/subprocess";
import { normalizeRunnerOutput } from "../src/runner-output.ts";
import { opencodeSdkRuntimeAdapter } from "../src/runtime/opencode-adapter.ts";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
const originalPipelineAgentTimeoutMs = process.env.PIPELINE_AGENT_TIMEOUT_MS;
const originalPipelineMcpGatewayUrl = process.env.PIPELINE_MCP_GATEWAY_URL;
const originalPipelineMcpGatewayAuthorization =
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
function makeSimpleResult(stdout = "output", exitCode = 0) {
  return Promise.resolve({ stdout, exitCode }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PIPELINE_AGENT_TIMEOUT_MS;
  process.env.PIPELINE_MCP_GATEWAY_URL = "http://127.0.0.1:8787/mcp";
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "test-gateway-token";
});

afterEach(() => {
  restoreEnv("PIPELINE_AGENT_TIMEOUT_MS", originalPipelineAgentTimeoutMs);
  restoreEnv("PIPELINE_MCP_GATEWAY_URL", originalPipelineMcpGatewayUrl);
  restoreEnv(
    "PIPELINE_MCP_GATEWAY_AUTHORIZATION",
    originalPipelineMcpGatewayAuthorization
  );
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function parseTestConfig(parts: {
  pipeline: string;
  profiles: string;
  runners: string;
}) {
  return parsePipelineConfigParts(parts);
}

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

  it("adds git info excludes before opencode launch plans run", async () => {
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

      await runLaunchPlan(
        createRunnerLaunchPlan(CONFIG, {
          profileId: "opencode-agent",
          nodeId: "node",
          prompt: "verify things",
          worktreePath: dir,
        })
      );

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

  it("keeps the OpenCode SDK adapter launch plan and output parsing behavior-compatible", () => {
    const plan = createRunnerLaunchPlan(CONFIG, {
      contextFile: "/tmp/context.md",
      profileId: "opencode-agent",
      nodeId: "opencode-node",
      prompt: "do OpenCode work",
      worktreePath: "/tmp/wt",
    });

    const launch = opencodeSdkRuntimeAdapter.launch(plan);
    const metadata = opencodeSdkRuntimeAdapter.sessionMetadata(plan);

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
      adapterId: "opencode-sdk",
      continuationApi: "session-reuse",
      nodeId: "opencode-node",
      outputFormat: "json",
      pluginEvents: "server-event-stream",
      profileId: "opencode-agent",
      runnerId: "opencode",
      sessionInspectionApi: "sdk",
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

    expect(opencodeSdkRuntimeAdapter.outputCandidates(stdout)).toEqual([
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

  it("uses explicit actor and runner models only", () => {
    const agent = createRunnerLaunchPlan(CONFIG, {
      profileId: "opencode-agent",
      nodeId: "agent",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    const orchestrator = createOrchestratorLaunchPlan(CONFIG, {
      nodeId: "orchestrator",
      prompt: "coordinate",
      worktreePath: "/tmp/wt",
    });

    expect(agent.args).toContain("openai/gpt-5.5");
    expect(orchestrator.args).toContain("orchestrator-model");
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

  it("streams subprocess stdout chunks before returning the final buffered result", async () => {
    const stdout = new EventEmitter();
    let resolveSubprocess: (result: unknown) => void = () => undefined;
    const subprocess = new Promise((resolve) => {
      resolveSubprocess = resolve;
    }) as Promise<unknown> & { stdout: EventEmitter };
    subprocess.stdout = stdout;
    mockExeca.mockReturnValue(subprocess);

    const plan = createRunnerLaunchPlan(CONFIG, {
      profileId: "opencode-agent",
      nodeId: "agent",
      prompt: "do work",
      worktreePath: "/tmp/wt",
    });
    const observed: string[] = [];
    const running = runLaunchPlan(plan, {
      onOutput: (event) => {
        observed.push(`${event.nodeId}:${event.stream}:${event.chunk}`);
      },
    }).then((result) => {
      observed.push(`result:${result.stdout}`);
      return result;
    });

    stdout.emit("data", Buffer.from("first live line\n"));
    await Promise.resolve();

    expect(observed).toEqual(["agent:stdout:first live line\n"]);

    stdout.emit("data", "second live line\n");
    resolveSubprocess({
      exitCode: 0,
      stderr: "",
      stdout: "first live line\nsecond live line\n",
    });
    const result = await running;

    expect(result.stdout).toBe("first live line\nsecond live line\n");
    expect(observed).toEqual([
      "agent:stdout:first live line\n",
      "agent:stdout:second live line\n",
      "result:first live line\nsecond live line\n",
    ]);
  });
});
