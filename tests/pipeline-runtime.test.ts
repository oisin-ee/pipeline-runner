import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePipelineConfigParts } from "../src/config";
import {
  type PipelineRuntimeEvent,
  runPipelineFromConfig,
} from "../src/pipeline-runtime";
import type { RunnerLaunchPlan } from "../src/runner";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));
interface GitMock {
  client: {
    add: ReturnType<typeof vi.fn>;
    addConfig: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    raw: ReturnType<typeof vi.fn>;
    revparse: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
  simpleGit: ReturnType<typeof vi.fn>;
}

let gitMock: GitMock;

(() => {
  interface GitStatusResult {
    files: { path: string }[];
  }
  const client = {
    add: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
    addConfig: vi.fn<(...args: unknown[]) => Promise<unknown>>(
      async () => undefined
    ),
    commit: vi.fn<(...args: unknown[]) => Promise<unknown>>(
      async () => undefined
    ),
    raw: vi.fn<(...commands: (string | string[])[]) => Promise<string>>(
      async () => ""
    ),
    revparse: vi.fn<(options: string[]) => Promise<string>>(
      async () => "base-sha"
    ),
    status: vi.fn(
      async (_options?: { baseDir?: string }): Promise<GitStatusResult> => ({
        files: [],
      })
    ),
  };
  gitMock = {
    client,
    simpleGit: vi.fn((options?: { baseDir?: string }) => ({
      add: client.add,
      addConfig: client.addConfig,
      commit: client.commit,
      raw: client.raw,
      revparse: client.revparse,
      status: () => client.status(options),
    })),
  };
})();

vi.mock("simple-git", () => ({
  default: (options?: { baseDir?: string }) => gitMock.simpleGit(options),
}));

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
const tempDirs: string[] = [];
const originalPipelineTestCommand = process.env.PIPELINE_TEST_COMMAND;
const originalPipelineSemgrepCommand = process.env.PIPELINE_SEMGREP_COMMAND;
const originalPipelineTypecheckCommand = process.env.PIPELINE_TYPECHECK_COMMAND;
const CANCEL_PATTERN = /cancel/i;
const LINE_SPLIT_RE = /\r?\n/;

beforeEach(() => {
  gitMock.client.add.mockResolvedValue(undefined);
  gitMock.client.addConfig.mockResolvedValue(undefined);
  gitMock.client.commit.mockResolvedValue(undefined);
  gitMock.client.raw.mockResolvedValue("");
  gitMock.client.revparse.mockResolvedValue("base-sha");
  gitMock.client.status.mockImplementation(async (options) =>
    gitStatusSnapshot(options?.baseDir)
  );
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalPipelineTestCommand === undefined) {
    delete process.env.PIPELINE_TEST_COMMAND;
  } else {
    process.env.PIPELINE_TEST_COMMAND = originalPipelineTestCommand;
  }
  if (originalPipelineSemgrepCommand === undefined) {
    delete process.env.PIPELINE_SEMGREP_COMMAND;
  } else {
    process.env.PIPELINE_SEMGREP_COMMAND = originalPipelineSemgrepCommand;
  }
  if (originalPipelineTypecheckCommand === undefined) {
    delete process.env.PIPELINE_TYPECHECK_COMMAND;
  } else {
    process.env.PIPELINE_TYPECHECK_COMMAND = originalPipelineTypecheckCommand;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function gitStatusSnapshot(baseDir?: string): {
  files: Array<{ path: string }>;
} {
  try {
    const stdout = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: baseDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return {
      files: stdout
        .split(LINE_SPLIT_RE)
        .filter(Boolean)
        .map((line) => line.slice(3))
        .map((path) => path.split(" -> ").at(-1) ?? path)
        .map((path) => ({ path })),
    };
  } catch {
    return { files: [] };
  }
}

function baseConfig(extraWorkflow = "") {
  return parsePipelineConfigParts({
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text, json, json_schema]
  command:
    type: command
    command: node
    args: ["-e", "{{prompt}}"]
    capabilities:
      native_subagents: false
      output_formats: [text, json]
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
  a:
    runner: opencode
    instructions: { inline: Agent A }
    output: { format: text }
  b:
    runner: opencode
    instructions: { inline: Agent B }
    output: { format: text }
  structured:
    runner: opencode
    instructions: { inline: Structured }
    output:
      format: json_schema
      schema_path: schema.json
`,
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
${extraWorkflow}
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
      - id: b
        kind: agent
        profile: b
        needs: [a]
`,
  });
}

function executor(outputs: Record<string, string | string[]>) {
  const counts = new Map<string, number>();
  return (plan: RunnerLaunchPlan) => {
    const current = counts.get(plan.nodeId) ?? 0;
    counts.set(plan.nodeId, current + 1);
    const value = outputs[plan.nodeId] ?? "ok";
    const stdout = Array.isArray(value)
      ? (value[current] ?? value.at(-1) ?? "")
      : value;
    return { exitCode: stdout === "__FAIL__" ? 1 : 0, stdout };
  };
}

function commandHookSuccess(stdout = "hook") {
  return (_command: string, _args: string[], options?: unknown) => {
    const env = (options as { env?: Record<string, string> } | undefined)?.env;
    if (env?.PIPELINE_HOOK_RESULT) {
      writeFileSync(
        env.PIPELINE_HOOK_RESULT,
        JSON.stringify({ status: "pass", summary: stdout })
      );
    }
    return { exitCode: 0, stdout, stderr: "" };
  };
}

describe("runPipelineFromConfig", () => {
  it("executes distinct agent boundaries and never merges multi-agent prompts", async () => {
    const project = tempProject();
    const seen: RunnerLaunchPlan[] = [];

    const result = await runPipelineFromConfig({
      config: baseConfig(),
      executor: (plan) => {
        seen.push(plan);
        return { exitCode: 0, stdout: `${plan.nodeId} done` };
      },
      task: "ship",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.agentInvocations.map((plan) => plan.nodeId)).toEqual([
      "a",
      "b",
    ]);
    expect(result.nodeStates.a).toMatchObject({
      attempts: 1,
      status: "passed",
    });
    expect(result.nodeStates.b).toMatchObject({
      attempts: 1,
      status: "passed",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].args.join("\n")).toContain("Node: a");
    expect(seen[1].args.join("\n")).toContain("Node: b");
  });

  it("renders node-specific task context in agent prompts", async () => {
    const project = tempProject();
    const config = baseConfig();
    config.workflows.default.nodes[0] = {
      ...config.workflows.default.nodes[0],
      task_context: {
        id: "PIPE-41.7",
        title: "Propagate node context",
        description: "Use the node ticket instead of the parent task.",
        acceptance_criteria: [
          { id: "1", text: "The prompt includes node context." },
        ],
      },
    } as (typeof config.workflows.default.nodes)[number];
    const seen: RunnerLaunchPlan[] = [];

    await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return { exitCode: 0, stdout: "ok" };
      },
      task: "PIPE-41",
      taskContext: {
        id: "PIPE-41",
        title: "Parent epic",
        acceptanceCriteria: [{ id: "P", text: "Parent criterion" }],
      },
      worktreePath: project,
    });

    const prompt = seen[0].args.join("\n");
    expect(prompt).toContain("ID: PIPE-41.7");
    expect(prompt).toContain("Title: Propagate node context");
    expect(prompt).toContain("- 1: The prompt includes node context.");
    expect(prompt).not.toContain("Parent criterion");
  });

  it("loads configured rules, skills, and MCP servers into agent boundaries", async () => {
    const project = tempProject();
    writeProjectFile(project, "rules/test-first.md", "Always write tests.");
    writeProjectFile(
      project,
      ".agents/skills/research/SKILL.md",
      "Use repository research."
    );
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read]
      output_formats: [text]
`,
      profiles: `
version: 1
rules:
  test-first:
    path: rules/test-first.md
skills:
  research:
    path: .agents/skills/research/SKILL.md
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    rules: [test-first]
    skills: [research]
    mcp_servers: [pipeline-gateway]
    tools: [read]
  a:
    runner: opencode
    instructions: { inline: Agent A }
    rules: [test-first]
    skills: [research]
    mcp_servers: [pipeline-gateway]
    tools: [read]
`,
      pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });
    const seen: RunnerLaunchPlan[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return { exitCode: 0, stdout: "ok" };
      },
      task: "ship",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    const launchText = seen[0].args.join("\n");
    expect(launchText).toContain("Loaded rules:");
    expect(launchText).toContain("Always write tests.");
    expect(launchText).toContain("Loaded skills:");
    expect(launchText).toContain("Use repository research.");
    expect(launchText).toContain("Loaded MCP servers:");
    expect(launchText).toContain("transport: http");
    expect(launchText).toContain("url: http://127.0.0.1:4483/mcp");
    expect(launchText).toContain("headers: Authorization");
    expect(launchText).toContain("bearer_token_env_var: none");
    expect(launchText).not.toContain("mcp_servers.pipeline-gateway.url");
    expect(launchText).not.toContain("mcp_servers.docs.command");
    expect(launchText).not.toContain("mcp_servers.memory.url");
  });

  it("runs parallel nodes concurrently after dependencies are met", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parallel:
    nodes:
      - { id: start, kind: agent, profile: a }
      - { id: left, kind: agent, profile: a, needs: [start] }
      - { id: right, kind: agent, profile: b, needs: [start] }
      - { id: join, kind: group, nodes: [left, right], needs: [left, right] }
`);
    const started: string[] = [];
    let leftRelease: (() => void) | undefined;
    const leftWaiting = new Promise<void>((resolve) => {
      leftRelease = resolve;
    });

    await runPipelineFromConfig({
      config,
      executor: async (plan) => {
        started.push(plan.nodeId);
        if (plan.nodeId === "left") {
          await leftWaiting;
        }
        if (plan.nodeId === "right") {
          leftRelease?.();
        }
        return { exitCode: 0, stdout: plan.nodeId };
      },
      task: "parallel",
      workflowId: "parallel",
      worktreePath: project,
    });

    expect(started[0]).toBe("start");
    expect(started.slice(1).sort()).toEqual(["left", "right"]);
  });

  it("limits parallel node execution when configured", async () => {
    const project = tempProject();
    const config = baseConfig(`
  limited:
    nodes:
      - { id: left, kind: agent, profile: a }
      - { id: right, kind: agent, profile: b }
`);
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: async (plan) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push(plan.nodeId);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return { exitCode: 0, stdout: plan.nodeId };
      },
      maxParallelNodes: 1,
      task: "parallel",
      workflowId: "limited",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(seen).toEqual(["left", "right"]);
    expect(maxActive).toBe(1);
  });

  it("starts descendants as soon as their own dependencies pass", async () => {
    const project = tempProject();
    const config = baseConfig(`
  dynamic:
    nodes:
      - { id: root, kind: agent, profile: a }
      - { id: slow, kind: agent, profile: a, needs: [root] }
      - { id: fast, kind: agent, profile: b, needs: [root] }
      - { id: child-fast, kind: agent, profile: b, needs: [fast] }
      - { id: join, kind: agent, profile: a, needs: [slow, child-fast] }
`);
    const starts = new Map<string, number>();
    const finishes = new Map<string, number>();
    const delays = new Map([
      ["root", 0],
      ["slow", 50],
      ["fast", 0],
      ["child-fast", 0],
      ["join", 0],
    ]);

    const result = await runPipelineFromConfig({
      config,
      executor: async (plan) => {
        starts.set(plan.nodeId, performance.now());
        await new Promise((resolve) =>
          setTimeout(resolve, delays.get(plan.nodeId) ?? 0)
        );
        finishes.set(plan.nodeId, performance.now());
        return { exitCode: 0, stdout: plan.nodeId };
      },
      task: "dynamic",
      workflowId: "dynamic",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(starts.get("child-fast") ?? 0).toBeLessThan(
      finishes.get("slow") ?? 0
    );
  });

  it("continues independent ready branches after a non fail-fast failure", async () => {
    const project = tempProject();
    const config = baseConfig(`
  independent-failure:
    execution:
      fail_fast: false
    nodes:
      - { id: root, kind: agent, profile: a }
      - { id: failing, kind: agent, profile: a, needs: [root] }
      - { id: fast, kind: agent, profile: b, needs: [root] }
      - { id: blocked, kind: agent, profile: a, needs: [failing] }
      - { id: child-fast, kind: agent, profile: b, needs: [fast] }
`);
    const seen: string[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan.nodeId);
        return {
          exitCode: plan.nodeId === "failing" ? 1 : 0,
          stdout: plan.nodeId,
        };
      },
      task: "independent failure",
      workflowId: "independent-failure",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(seen).toContain("child-fast");
    expect(seen).not.toContain("blocked");
    expect(result.nodeStates.blocked).toMatchObject({ status: "pending" });
    expect(result.nodeStates["child-fast"]).toMatchObject({ status: "passed" });
  });

  it("uses workflow execution config to limit parallel node execution", async () => {
    const project = tempProject();
    const config = baseConfig(`
  limited:
    execution:
      max_parallel_nodes: 1
    nodes:
      - { id: left, kind: agent, profile: a }
      - { id: right, kind: agent, profile: b }
`);
    let active = 0;
    let maxActive = 0;

    const result = await runPipelineFromConfig({
      config,
      executor: async (plan) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return { exitCode: 0, stdout: plan.nodeId };
      },
      task: "parallel",
      workflowId: "limited",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(maxActive).toBe(1);
  });

  it("stops a ready batch when fail_fast is enabled", async () => {
    const project = tempProject();
    const config = baseConfig(`
  fail-fast:
    execution:
      fail_fast: true
    nodes:
      - { id: left, kind: agent, profile: a }
      - { id: right, kind: agent, profile: b }
`);
    const seen: string[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan.nodeId);
        return { exitCode: plan.nodeId === "left" ? 1 : 0, stdout: "" };
      },
      task: "parallel",
      workflowId: "fail-fast",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(seen).toEqual(["left"]);
    expect(result.nodeStates.left).toMatchObject({ status: "failed" });
    expect(result.nodeStates.right).toMatchObject({ status: "skipped" });
  });

  it("fails missing artifact gates and blocks dependents", async () => {
    const project = tempProject();
    const config = baseConfig(`
  artifact-flow:
    nodes:
      - id: produce
        kind: agent
        profile: a
        artifacts:
          - path: out.json
      - id: dependent
        kind: agent
        profile: b
        needs: [produce]
`);

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ produce: "done" }),
      task: "artifact",
      workflowId: "artifact-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.nodeStates.produce).toMatchObject({
      status: "failed",
    });
    expect(result.nodeStates.dependent).toMatchObject({
      status: "pending",
    });
    expect(result.gates[0]).toMatchObject({
      kind: "artifact",
      passed: false,
    });
    expect(result.agentInvocations.map((plan) => plan.nodeId)).toEqual([
      "produce",
    ]);
  });

  it("retries failed gated nodes", async () => {
    const project = tempProject();
    const config = baseConfig(`
  retry-flow:
    nodes:
      - id: flaky
        kind: agent
        profile: a
        retries: { max_attempts: 2 }
        gates:
          - kind: command
            command: [check-flaky]
`);
    mockExeca
      .mockRejectedValueOnce({ exitCode: 1, stdout: "no", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "yes", stderr: "" } as any);

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ flaky: "done" }),
      task: "retry",
      workflowId: "retry-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.nodes[0]).toMatchObject({ attempts: 2, status: "passed" });
  });

  it("emits stable actor observability for hooks, gates, and retry scheduling", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: retry-observability
hooks:
  functions:
    announce:
      kind: command
      command: [hook-bin]
      trusted: true
  on:
    workflow.start:
      - id: announce
        function: announce
        failure: fail
orchestrator:
  profile: orchestrator
workflows:
  retry-observability:
    nodes:
      - id: flaky
        kind: agent
        profile: a
        retries: { max_attempts: 2 }
        gates:
          - id: retry-gate
            kind: command
            command: [check-flaky]
`,
    });
    mockExeca
      .mockImplementationOnce(commandHookSuccess("hook"))
      .mockRejectedValueOnce({ exitCode: 1, stdout: "no", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "yes", stderr: "" });
    const events: PipelineRuntimeEvent[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ flaky: "done" }),
      reporter: (event) => events.push(event),
      task: "retry observability",
      workflowId: "retry-observability",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(
      events.filter((event) => event.type === "runtime.observability")
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runtime.hook.started",
          summary: "hook announce started",
          type: "runtime.observability",
          workflowId: "retry-observability",
        }),
        expect.objectContaining({
          name: "runtime.gate.started",
          nodeId: "flaky",
          summary: "gate retry-gate started for node flaky",
          type: "runtime.observability",
        }),
        expect.objectContaining({
          level: "info",
          name: "runtime.retry.scheduled",
          nodeId: "flaky",
          summary: "node flaky retry scheduled for attempt 2 (gate_failure)",
          type: "runtime.observability",
        }),
      ])
    );
    expect(JSON.stringify(events)).not.toContain("@xstate");
    expect(JSON.stringify(events)).not.toContain('snapshot":{"');
  });

  it("runs the default builtin semgrep gate through uvx", async () => {
    const project = tempProject();
    writeProjectFile(project, "src/app.ts", "export const value = 1;\n");
    execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test User"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "src/app.ts"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync("git", ["commit", "-m", "initial"], {
      cwd: project,
      stdio: "ignore",
    });
    delete process.env.PIPELINE_SEMGREP_COMMAND;
    const config = baseConfig(`
  semgrep-flow:
    nodes:
      - id: checked
        kind: agent
        profile: a
        gates:
          - id: verify-semgrep
            kind: builtin
            builtin: semgrep
`);
    mockExeca.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: "semgrep ok",
    });

    const result = await runPipelineFromConfig({
      config,
      executor: () => {
        writeProjectFile(project, "src/app.ts", "export const value = 2;\n");
        return { exitCode: 0, stdout: "done" };
      },
      task: "semgrep",
      workflowId: "semgrep-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.gates[0]).toMatchObject({
      gateId: "verify-semgrep",
      kind: "builtin",
      passed: true,
    });
    expect(mockExeca).toHaveBeenCalledWith(
      "uvx",
      ["semgrep", "scan", "--config=p/ci", "--error", "--", "src/app.ts"],
      expect.objectContaining({ cwd: project })
    );
  });

  it("honors retry_on when deciding whether to retry a failed node", async () => {
    const project = tempProject();
    const config = baseConfig(`
  retry-flow:
    nodes:
      - id: flaky
        kind: agent
        profile: a
        retries:
          max_attempts: 2
          retry_on: [exit_nonzero]
        gates:
          - kind: command
            command: [check-flaky]
`);
    mockExeca.mockRejectedValueOnce({ exitCode: 1, stdout: "no", stderr: "" });
    const events: PipelineRuntimeEvent[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ flaky: "done" }),
      reporter: (event) => events.push(event),
      task: "retry",
      workflowId: "retry-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.nodes[0]).toMatchObject({ attempts: 1, status: "failed" });
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === "runtime.observability")
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          name: "runtime.retry.exhausted",
          nodeId: "flaky",
          summary: "node flaky retry exhausted after attempt 1 (gate_failure)",
          type: "runtime.observability",
        }),
      ])
    );
  });

  it("applies node timeout to agent and command execution", async () => {
    const project = tempProject();
    const config = baseConfig(`
  timeout-flow:
    nodes:
      - id: agent-timeout
        kind: agent
        profile: a
        timeout_ms: 1234
      - id: command-timeout
        kind: command
        command: [node, slow.js]
        timeout_ms: 2345
        needs: [agent-timeout]
`);
    mockExeca.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    const timeouts: Array<number | undefined> = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        timeouts.push(plan.timeoutMs);
        return { exitCode: 0, stdout: "done" };
      },
      task: "timeout",
      workflowId: "timeout-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(timeouts).toEqual([1234]);
    expect(mockExeca).toHaveBeenCalledWith(
      "node",
      ["slow.js"],
      expect.objectContaining({ timeout: 2345 })
    );
  });

  it("retries timed-out command nodes when retry_on includes timeout", async () => {
    const project = tempProject();
    const config = baseConfig(`
  timeout-retry:
    nodes:
      - id: command-timeout
        kind: command
        command: [node, slow.js]
        timeout_ms: 50
        retries:
          max_attempts: 2
          retry_on: [timeout]
`);
    mockExeca
      .mockRejectedValueOnce({
        exitCode: 1,
        stderr: "",
        stdout: "",
        timedOut: true,
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    const result = await runPipelineFromConfig({
      config,
      task: "timeout",
      workflowId: "timeout-retry",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.nodes[0]).toMatchObject({ attempts: 2, status: "passed" });
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });

  it("validates JSON schema output gates", async () => {
    const project = tempProject();
    writeProjectFile(
      project,
      "schema.json",
      JSON.stringify({
        additionalProperties: false,
        properties: { verdict: { enum: ["PASS"], type: "string" } },
        required: ["verdict"],
        type: "object",
      })
    );
    const config = baseConfig(`
  structured-flow:
    nodes:
      - id: structured
        kind: agent
        profile: structured
`);
    config.profiles.structured.output = {
      format: "json_schema",
      repair: { enabled: false },
      schema_path: "schema.json",
    };

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ structured: '{"verdict":"FAIL"}' }),
      task: "schema",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.gates[0]).toMatchObject({
      kind: "json_schema",
      passed: false,
    });
  });

  it("validates package standard implementation output without repo-local schema files", async () => {
    const project = tempProject();
    const config = baseConfig(`
  structured-flow:
    nodes:
      - id: structured
        kind: agent
        profile: structured
`);
    config.profiles.structured.output = {
      format: "json_schema",
      repair: { enabled: false },
      schema_path: ".pipeline/schemas/implementation.schema.json",
    };

    const result = await runPipelineFromConfig({
      config,
      executor: executor({
        structured: JSON.stringify({
          changes: [
            {
              files: ["src/app.ts"],
              summary: "Add explicit runner PR summaries",
              why: "Runner PRs need validated change rationale",
            },
          ],
          verification: ["bun run test tests/pipeline-runtime.test.ts"],
        }),
      }),
      task: "schema",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.gates[0]).toMatchObject({
      kind: "json_schema",
      passed: true,
    });
    expect(result.structuredOutputs).toHaveLength(1);
    expect(result.structuredOutputs[0]).toMatchObject({
      nodeId: "structured",
      profileId: "structured",
      schemaPath: ".pipeline/schemas/implementation.schema.json",
      validation: { status: "valid", passed: true },
    });
    expect(result.structuredOutputs[0]?.output).toMatchObject({
      changes: [
        {
          files: ["src/app.ts"],
          summary: "Add explicit runner PR summaries",
          why: "Runner PRs need validated change rationale",
        },
      ],
    });
  });

  it("fails package standard implementation output when a change omits why", async () => {
    const project = tempProject();
    const config = baseConfig(`
  structured-flow:
    nodes:
      - id: structured
        kind: agent
        profile: structured
`);
    config.profiles.structured.output = {
      format: "json_schema",
      repair: { enabled: false },
      schema_path: ".pipeline/schemas/implementation.schema.json",
    };

    const result = await runPipelineFromConfig({
      config,
      executor: executor({
        structured: JSON.stringify({
          changes: [
            {
              files: ["src/app.ts"],
              summary: "Add explicit runner PR summaries",
            },
          ],
          verification: ["bun run test tests/pipeline-runtime.test.ts"],
        }),
      }),
      task: "schema",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.gates[0]).toMatchObject({
      kind: "json_schema",
      passed: false,
    });
    expect(result.gates[0]?.evidence.join("\n")).toContain("why");
  });

  it("applies JSON schema format validators to structured output", async () => {
    const project = tempProject();
    writeProjectFile(
      project,
      "schema.json",
      JSON.stringify({
        additionalProperties: false,
        properties: { id: { format: "uuid", type: "string" } },
        required: ["id"],
        type: "object",
      })
    );
    const config = baseConfig(`
  structured-flow:
    nodes:
      - id: structured
        kind: agent
        profile: structured
`);
    config.profiles.structured.output = {
      format: "json_schema",
      repair: { enabled: false },
      schema_path: "schema.json",
    };

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ structured: '{"id":"not-a-uuid"}' }),
      task: "schema format",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.gates[0]).toMatchObject({
      kind: "json_schema",
      passed: false,
    });
    expect(result.gates[0].evidence.join("\n")).toContain("uuid");
  });

  it("selects the latest OpenCode text event that validates against the profile schema", async () => {
    const project = tempProject();
    writeProjectFile(
      project,
      "schema.json",
      JSON.stringify({
        additionalProperties: false,
        properties: { verdict: { enum: ["PASS"], type: "string" } },
        required: ["verdict"],
        type: "object",
      })
    );
    const config = baseConfig(`
  structured-flow:
    nodes:
      - id: structured
        kind: agent
        profile: structured
`);
    config.runners.opencode = {
      capabilities: {
        native_subagents: true,
        output_formats: ["text", "json", "json_schema"],
      },
      command: "opencode",
      type: "opencode",
    };
    config.profiles.structured.runner = "opencode";
    config.profiles.structured.output = {
      format: "json_schema",
      repair: { enabled: false },
      schema_path: "schema.json",
    };
    const opencodeEvents = [
      JSON.stringify({
        part: {
          text: JSON.stringify({ verdict: "PASS" }),
          type: "text",
        },
        type: "text",
      }),
      JSON.stringify({
        part: {
          text: "Static verification complete",
          type: "text",
        },
        type: "text",
      }),
    ].join("\n");

    const result = await runPipelineFromConfig({
      config,
      executor: () => ({ exitCode: 0, stdout: opencodeEvents }),
      task: "schema",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.nodes[0].output).toBe('{"verdict":"PASS"}');
    expect(result.nodes[0].evidence).toContain(
      "selected valid structured output for structured"
    );
    expect(result.agentInvocations).toHaveLength(1);
  });

  it("repairs invalid JSON schema output before gates evaluate it", async () => {
    const project = tempProject();
    writeProjectFile(
      project,
      "schema.json",
      JSON.stringify({
        additionalProperties: false,
        properties: { verdict: { enum: ["PASS"], type: "string" } },
        required: ["verdict"],
        type: "object",
      })
    );
    const config = baseConfig(`
  structured-flow:
    nodes:
      - id: structured
        kind: agent
        profile: structured
`);
    const seen: RunnerLaunchPlan[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return {
          exitCode: 0,
          stdout:
            plan.nodeId === "structured:output-repair"
              ? '{"verdict":"PASS"}'
              : "verdict is pass",
        };
      },
      task: "schema",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.nodes[0].output).toBe('{"verdict":"PASS"}');
    expect(result.nodes[0].evidence).toContain(
      "output repair passed for structured after attempt 1"
    );
    expect(result.gates[0]).toMatchObject({
      kind: "json_schema",
      passed: true,
    });
    expect(seen.map((plan) => plan.nodeId)).toEqual([
      "structured",
      "structured:output-repair",
    ]);
    expect(seen[1]).toMatchObject({
      outputFormat: "text",
      profileId: "structured:output-repair",
      runnerId: "opencode",
    });
    expect(seen[1].args.join("\n")).toContain("Return only valid JSON");
  });

  it("fails with repair evidence when repaired output still violates the schema", async () => {
    const project = tempProject();
    writeProjectFile(
      project,
      "schema.json",
      JSON.stringify({
        additionalProperties: false,
        properties: { verdict: { enum: ["PASS"], type: "string" } },
        required: ["verdict"],
        type: "object",
      })
    );
    const config = baseConfig(`
  structured-flow:
    nodes:
      - id: structured
        kind: agent
        profile: structured
`);

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => ({
        exitCode: 0,
        stdout:
          plan.nodeId === "structured:output-repair"
            ? '{"verdict":"FAIL"}'
            : "verdict is pass",
      }),
      task: "schema",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.nodes[0].evidence).toContain(
      "output repair failed for structured after attempt 1"
    );
    expect(result.gates[0]).toMatchObject({
      kind: "json_schema",
      passed: false,
    });
  });

  it("fails verifier output semantically when verdict is FAIL despite valid JSON", async () => {
    const project = tempProject();
    const config = baseConfig(`
  verdict-flow:
    nodes:
      - id: structured
        kind: agent
        profile: a
        gates:
          - id: verifier-verdict
            kind: verdict
            target: stdout
`);

    const result = await runPipelineFromConfig({
      config,
      executor: executor({
        structured: JSON.stringify({
          verdict: "FAIL",
          evidence: ["missing coverage"],
        }),
      }),
      task: "verdict",
      workflowId: "verdict-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.gates[0]).toMatchObject({
      kind: "verdict",
      passed: false,
      reason: "verdict requirement failed",
    });
  });

  it("checks acceptance coverage against normalized task context", async () => {
    const project = tempProject();
    const config = baseConfig(`
  acceptance-flow:
    nodes:
      - id: review
        kind: agent
        profile: a
        gates:
          - id: acceptance-coverage
            kind: acceptance
            target: stdout
`);

    const result = await runPipelineFromConfig({
      config,
      executor: executor({
        review: JSON.stringify({
          acceptance: [
            { id: "AC1", verdict: "PASS", evidence: ["test proves AC1"] },
            { id: "AC2", verdict: "FAIL", evidence: ["not implemented"] },
            { id: "EXTRA", verdict: "PASS", evidence: ["unknown"] },
          ],
        }),
      }),
      task: "acceptance",
      taskContext: {
        acceptanceCriteria: [
          { id: "AC1", text: "First criterion" },
          { id: "AC2", text: "Second criterion" },
          { id: "AC3", text: "Third criterion" },
        ],
      },
      workflowId: "acceptance-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.gates[0].evidence).toEqual(
      expect.arrayContaining([
        "acceptance criterion 'AC2' verdict 'FAIL'",
        "extra acceptance criterion 'EXTRA'",
        "missing acceptance criterion 'AC3'",
      ])
    );
  });

  it("remediates implementation-role nodes when downstream coverage fails", async () => {
    const project = tempProject();
    const config = baseConfig(`
  remediate-flow:
    nodes:
      - id: implement
        kind: agent
        profile: a
      - id: review
        kind: agent
        profile: b
        needs: [implement]
        gates:
          - id: acceptance-coverage
            kind: acceptance
            target: stdout
          - id: acceptance-verdict
            kind: verdict
            target: stdout
`);
    config.profiles.a.scheduling_roles = ["implementation"];
    config.profiles.b.scheduling_roles = ["coverage"];
    const seen: RunnerLaunchPlan[] = [];
    let reviewAttempt = 0;

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        if (plan.nodeId === "review") {
          reviewAttempt += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              reviewAttempt === 1
                ? {
                    acceptance: [
                      {
                        evidence: ["missing implementation evidence"],
                        id: "AC1",
                        verdict: "FAIL",
                      },
                    ],
                    evidence: ["AC1 is not satisfied"],
                    verdict: "FAIL",
                  }
                : {
                    acceptance: [
                      {
                        evidence: ["remediation satisfied AC1"],
                        id: "AC1",
                        verdict: "PASS",
                      },
                    ],
                    evidence: ["all criteria pass after remediation"],
                    verdict: "PASS",
                  }
            ),
          };
        }
        return {
          exitCode: 0,
          stdout: plan.nodeId.includes(":remediate:")
            ? "remediated implementation output"
            : "implementation output",
        };
      },
      task: "acceptance remediation",
      taskContext: {
        acceptanceCriteria: [{ id: "AC1", text: "Criterion one" }],
      },
      workflowId: "remediate-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(seen.map((plan) => plan.nodeId)).toEqual([
      "implement",
      "review",
      "implement:remediate:review:1",
      "review",
    ]);
    expect(seen[2]?.args.join("\n")).toContain("Coverage failure feedback:");
    expect(seen[2]?.args.join("\n")).toContain("acceptance criterion 'AC1'");
    expect(result.nodeStates.review).toMatchObject({
      attempts: 2,
      status: "passed",
    });
  });

  it("includes builtin gate command failures in coverage remediation prompts", async () => {
    const project = tempProject();
    process.env.PIPELINE_TYPECHECK_COMMAND = "node -e process.exit(1)";
    mockExeca
      .mockRejectedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "ok" });
    const config = baseConfig(`
  remediate-builtin-flow:
    nodes:
      - id: implement
        kind: agent
        profile: a
      - id: verify
        kind: agent
        profile: b
        needs: [implement]
        gates:
          - id: verify-typecheck
            kind: builtin
            builtin: typecheck
`);
    config.profiles.a.scheduling_roles = ["implementation"];
    config.profiles.b.scheduling_roles = ["coverage"];
    const seen: RunnerLaunchPlan[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return {
          exitCode: 0,
          stdout: plan.nodeId.includes(":remediate:")
            ? "remediated implementation output"
            : "node output",
        };
      },
      task: "builtin remediation",
      workflowId: "remediate-builtin-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(seen.map((plan) => plan.nodeId)).toEqual([
      "implement",
      "verify",
      "implement:remediate:verify:1",
      "verify",
    ]);
    const remediationPrompt = seen[2]?.args.join("\n") ?? "";
    expect(remediationPrompt).toContain("Failed gate:\nverify-typecheck");
    expect(remediationPrompt).toContain(
      "builtin 'typecheck' exited 1: node -e process.exit(1)"
    );
    expect(remediationPrompt).toContain(
      "builtin 'typecheck' produced no output"
    );
  });

  it("injects stdout gate JSON contracts into agent prompts", async () => {
    const project = tempProject();
    const seen: RunnerLaunchPlan[] = [];
    const config = baseConfig(`
  acceptance-flow:
    nodes:
      - id: review
        kind: agent
        profile: a
        gates:
          - id: acceptance-coverage
            kind: acceptance
            target: stdout
          - id: acceptance-verdict
            kind: verdict
            target: stdout
`);

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            acceptance: [
              { id: "AC1", verdict: "PASS", evidence: ["reviewed AC1"] },
            ],
            evidence: ["reviewed all criteria"],
            verdict: "PASS",
          }),
        };
      },
      task: "acceptance",
      taskContext: {
        acceptanceCriteria: [{ id: "AC1", text: "Do the thing" }],
      },
      workflowId: "acceptance-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    const prompt = seen[0].args.join("\n");
    expect(prompt).toContain("Gate output contract:");
    expect(prompt).toContain("Return only valid JSON");
    expect(prompt).toContain('"acceptance"');
    expect(prompt).toContain('"verdict" ("PASS" or "FAIL")');
    expect(prompt).toContain("Do not use Markdown fences or add prose");
  });

  it("keeps acceptance gates strict when a gated agent returns prose", async () => {
    const project = tempProject();
    const seen: RunnerLaunchPlan[] = [];
    const config = baseConfig(`
  acceptance-flow:
    nodes:
      - id: review
        kind: agent
        profile: a
        gates:
          - id: acceptance-coverage
            kind: acceptance
            target: stdout
          - id: acceptance-verdict
            kind: verdict
            target: stdout
`);

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return {
          exitCode: 0,
          stdout: "**Acceptance review**\n\nAC1 passes.",
        };
      },
      task: "acceptance",
      taskContext: {
        acceptanceCriteria: [{ id: "AC1", text: "Do the thing" }],
      },
      workflowId: "acceptance-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.gates[0]).toMatchObject({
      kind: "acceptance",
      passed: false,
      reason: "acceptance gate JSON parse failed",
    });
    expect(result.gates[0].evidence.join("\n")).toContain("gate JSON");
    expect(seen[0].args.join("\n")).toContain("Return only valid JSON");
  });

  it("injects normalized task context into agent prompts", async () => {
    const project = tempProject();
    const seen: RunnerLaunchPlan[] = [];

    await runPipelineFromConfig({
      config: baseConfig(),
      executor: (plan) => {
        seen.push(plan);
        return { exitCode: 0, stdout: "ok" };
      },
      task: "PIPE-1",
      taskContext: {
        acceptanceCriteria: [{ id: "AC1", text: "Do the thing" }],
        description: "Detailed task body",
        id: "PIPE-1",
        title: "Task title",
      },
      worktreePath: project,
    });

    const prompt = seen[0].args.join("\n");
    expect(prompt).toContain("Canonical task context:");
    expect(prompt).toContain("ID: PIPE-1");
    expect(prompt).toContain("- AC1: Do the thing");
  });

  it("runs parallel container children concurrently and honors maxParallelNodes", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parallel-container:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: agent
            profile: a
          - id: middle
            kind: agent
            profile: a
          - id: right
            kind: agent
            profile: b
`);
    const seen: string[] = [];
    let active = 0;
    let maxActive = 0;

    const result = await runPipelineFromConfig({
      config,
      executor: async (plan) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        seen.push(plan.nodeId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { exitCode: 0, stdout: `${plan.nodeId} output` };
      },
      maxParallelNodes: 2,
      task: "parallel container",
      workflowId: "parallel-container",
      worktreePath: project,
    });

    const fanout = result.nodes.find((node) => node.nodeId === "fanout");
    if (!fanout) {
      throw new Error("Expected fanout container result");
    }

    expect(result.outcome).toBe("PASS");
    expect(seen.sort()).toEqual(["left", "middle", "right"]);
    expect(maxActive).toBe(2);
    expect(JSON.parse(fanout.output)).toEqual({
      children: {
        left: "left output",
        middle: "middle output",
        right: "right output",
      },
    });
  });

  it("runs all parallel siblings without failFast and reports aggregate failure", async () => {
    const project = tempProject();
    const config = baseConfig(`
  aggregate-failure:
    execution:
      fail_fast: false
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: bad
            kind: agent
            profile: a
          - id: good
            kind: agent
            profile: b
          - id: also-good
            kind: agent
            profile: a
`);
    const seen: string[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan.nodeId);
        return {
          exitCode: plan.nodeId === "bad" ? 1 : 0,
          stdout: `${plan.nodeId} output`,
        };
      },
      task: "parallel container",
      workflowId: "aggregate-failure",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(seen.sort()).toEqual(["also-good", "bad", "good"]);
    expect(result.nodes).toEqual([
      expect.objectContaining({
        exitCode: 1,
        nodeId: "fanout",
        status: "failed",
      }),
    ]);
    expect(result.nodeStates.fanout).toMatchObject({ status: "failed" });
  });

  it("stops pending parallel siblings and aborts running siblings when failFast is enabled", async () => {
    const project = tempProject();
    const config = baseConfig(`
  fail-fast-parallel:
    execution:
      fail_fast: true
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: fail
            kind: agent
            profile: a
          - id: slow
            kind: agent
            profile: b
          - id: pending
            kind: agent
            profile: a
`);
    const started: string[] = [];
    let slowAbortObserved = false;

    const result = await runPipelineFromConfig({
      config,
      executor: async (plan, options) => {
        started.push(plan.nodeId);
        if (plan.nodeId === "fail") {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { exitCode: 1, stdout: "failed" };
        }
        if (plan.nodeId === "slow") {
          return new Promise((resolve) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                slowAbortObserved = true;
                resolve({ exitCode: 1, stdout: "aborted" });
              },
              { once: true }
            );
            setTimeout(() => resolve({ exitCode: 0, stdout: "slow done" }), 50);
          });
        }
        return { exitCode: 0, stdout: "pending should not start" };
      },
      maxParallelNodes: 2,
      task: "parallel container",
      workflowId: "fail-fast-parallel",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(started).toEqual(expect.arrayContaining(["fail", "slow"]));
    expect(started).not.toContain("pending");
    expect(slowAbortObserved).toBe(true);
    expect(result.nodeStates.fanout).toMatchObject({ status: "failed" });
  });

  it("emits parallel container lifecycle and prefixed child reporter events", async () => {
    const project = tempProject();
    const events: Record<string, unknown>[] = [];
    const config = baseConfig(`
  parallel-events:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: agent
            profile: a
          - id: right
            kind: agent
            profile: b
`);

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => ({ exitCode: 0, stdout: `${plan.nodeId} ok` }),
      reporter: (event) => events.push(event),
      task: "parallel events",
      workflowId: "parallel-events",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: "fanout",
          type: "node.start",
        }),
        expect.objectContaining({
          nodeId: "fanout.left",
          parentNodeId: "fanout",
          type: "node.start",
        }),
        expect.objectContaining({
          nodeId: "fanout.left",
          parentNodeId: "fanout",
          type: "agent.start",
        }),
        expect.objectContaining({
          nodeId: "fanout.right",
          parentNodeId: "fanout",
          type: "node.finish",
        }),
        expect.objectContaining({
          nodeId: "fanout",
          status: "passed",
          type: "node.finish",
        }),
      ])
    );
  });

  it("enforces changed-file policies around a node", async () => {
    const project = tempProject();
    execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
    const config = baseConfig(`
  file-policy:
    nodes:
      - id: writer
        kind: agent
        profile: a
        gates:
          - id: tests-only
            kind: changed_files
            changed_files:
              require_any: ["tests/**/*.test.ts"]
              deny: ["src/**"]
`);

    const result = await runPipelineFromConfig({
      config,
      executor: () => {
        writeProjectFile(project, "src/app.ts", "export const x = 1;\n");
        return { exitCode: 0, stdout: "changed source only" };
      },
      task: "files",
      workflowId: "file-policy",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.gates[0].evidence).toEqual(
      expect.arrayContaining([
        "denied changes: src/app.ts",
        "missing required changes matching: tests/**/*.test.ts",
      ])
    );
  });

  it("remediates writable nodes when their changed-file gate fails", async () => {
    const project = tempProject();
    execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
    const config = baseConfig(`
  file-policy:
    nodes:
      - id: writer
        kind: agent
        profile: a
        gates:
          - id: tests-only
            kind: changed_files
            changed_files:
              require_any: ["tests/**/*.test.ts"]
`);
    config.profiles.a.filesystem = { mode: "workspace-write" };
    const seen: RunnerLaunchPlan[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        if (plan.nodeId.includes(":remediate:")) {
          writeProjectFile(project, "tests/generated.test.ts", "test('ok');\n");
          return { exitCode: 0, stdout: "remediated test file" };
        }
        return { exitCode: 0, stdout: "changed no files" };
      },
      task: "files",
      workflowId: "file-policy",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(seen.map((plan) => plan.nodeId)).toEqual([
      "writer",
      "writer:remediate:tests-only:1",
    ]);
    expect(seen[1]?.args.join("\n")).toContain("Gate failure feedback:");
    expect(seen[1]?.args.join("\n")).toContain(
      "missing required changes matching: tests/**/*.test.ts"
    );
    expect(result.nodeStates.writer).toMatchObject({
      attempts: 2,
      status: "passed",
    });
    expect(result.gates.at(-1)).toMatchObject({
      gateId: "tests-only",
      nodeId: "writer:remediate:tests-only:1",
      passed: true,
    });
  });

  it("counts files modified by a node even when they were already dirty", async () => {
    const project = tempProject();
    execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
    writeProjectFile(project, "tests/existing.test.ts", "before\n");
    const config = baseConfig(`
  file-policy:
    nodes:
      - id: writer
        kind: agent
        profile: a
        gates:
          - id: tests-only
            kind: changed_files
            changed_files:
              require_any: ["tests/**/*.test.ts"]
`);

    const result = await runPipelineFromConfig({
      config,
      executor: () => {
        writeProjectFile(project, "tests/existing.test.ts", "before\nafter\n");
        return { exitCode: 0, stdout: "changed dirty test" };
      },
      task: "files",
      workflowId: "file-policy",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.gates[0].evidence).toEqual([
      "changed files: tests/existing.test.ts",
    ]);
  });

  it("counts an already-dirty tracked test file even when the node restores it to clean", async () => {
    const project = tempProject();
    execFileSync("git", ["init"], { cwd: project, stdio: "ignore" });
    writeProjectFile(project, "tests/existing.test.ts", "baseline\n");
    execFileSync("git", ["add", "tests/existing.test.ts"], {
      cwd: project,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=pipeline@example.invalid",
        "-c",
        "user.name=Pipeline Test",
        "commit",
        "-m",
        "baseline",
      ],
      { cwd: project, stdio: "ignore" }
    );
    writeProjectFile(project, "tests/existing.test.ts", "dirty before\n");
    const config = baseConfig(`
  file-policy:
    nodes:
      - id: writer
        kind: agent
        profile: a
        gates:
          - id: tests-only
            kind: changed_files
            changed_files:
              require_any: ["tests/**/*.test.ts"]
`);

    const result = await runPipelineFromConfig({
      config,
      executor: () => {
        writeProjectFile(project, "tests/existing.test.ts", "baseline\n");
        return { exitCode: 0, stdout: "restored dirty test" };
      },
      task: "files",
      workflowId: "file-policy",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.gates[0].evidence).toEqual([
      "changed files: tests/existing.test.ts",
    ]);
  });

  it("runs command hooks with file input and required failure semantics", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  functions:
    required-start:
      kind: command
      command: [hook-bin]
      trusted: true
  on:
    node.start:
      - id: required-start
        function: required-start
        failure: fail
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });
    mockExeca.mockRejectedValueOnce({
      exitCode: 1,
      stdout: "bad hook",
      stderr: "",
    });

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ a: "never" }),
      task: "hook task",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.hookFailures[0]).toMatchObject({ gate: "required-start" });
    expect(mockExeca).toHaveBeenCalledWith(
      "hook-bin",
      [],
      expect.objectContaining({
        cwd: project,
        env: expect.objectContaining({
          PIPELINE_HOOK_INPUT: expect.any(String),
          PIPELINE_HOOK_RESULT: expect.any(String),
        }),
      })
    );
    expect(result.agentInvocations).toEqual([]);
  });

  it("dispatches orchestrator workflow hooks before workflow hooks", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  functions:
    orchestrator-start:
      kind: command
      command: [hook-bin, orchestrator]
      trusted: true
    workflow-start:
      kind: command
      command: [hook-bin, workflow]
      trusted: true
  on:
    workflow.start:
      - id: orchestrator-start
        function: orchestrator-start
        failure: fail
      - id: workflow-start
        function: workflow-start
        failure: fail
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });
    mockExeca.mockImplementation(commandHookSuccess("ok"));

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ a: "ok" }),
      task: "hook order",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(mockExeca.mock.calls.map((call) => call[1]?.[0])).toEqual([
      "orchestrator",
      "workflow",
    ]);
  });

  it("enforces hook trust policy, sanitized env, output limits, and JSON stdin payloads", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  functions:
    start:
      kind: command
      command: [hook-bin]
      trusted: true
      env:
        passthrough: [PATH]
        set: { HOOK_ONLY: "yes" }
      output_limit_bytes: 4
  on:
    workflow.start:
      - id: start
        function: start
        failure: fail
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });
    mockExeca.mockImplementation(commandHookSuccess("abcdef"));

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ a: "ok" }),
      hookPolicy: {
        env: { GLOBAL_HOOK: "1" },
        envPassthrough: ["PATH"],
      },
      task: "hook payload",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(mockExeca).toHaveBeenCalledWith(
      "hook-bin",
      [],
      expect.objectContaining({
        cwd: project,
        env: expect.objectContaining({
          GLOBAL_HOOK: "1",
          HOOK_ONLY: "yes",
          PIPELINE_HOOK_INPUT: expect.any(String),
          PIPELINE_HOOK_RESULT: expect.any(String),
        }),
        extendEnv: false,
        maxBuffer: 4,
      })
    );
  });

  it("fails required untrusted hooks when host policy disallows them", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  functions:
    start:
      kind: command
      command: [hook-bin]
      trusted: false
  on:
    workflow.start:
      - id: start
        function: start
        failure: fail
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ a: "never" }),
      hookPolicy: { allowUntrustedCommandHooks: false },
      task: "untrusted",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.hookFailures[0].evidence).toContain(
      "command hook is not trusted"
    );
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("runs module hook functions and publishes validated return values", async () => {
    const project = tempProject();
    writeProjectFile(
      project,
      ".pipeline/hooks/audit.mjs",
      `
export default async function audit(ctx) {
  return {
    status: "pass",
    summary: "Generated defaults are clean for " + ctx.workflow.id,
    outputs: {
      task: ctx.task,
      workflowId: ctx.workflow.id,
      custom: ctx.input.custom
    }
  };
}
`
    );
    writeProjectFile(
      project,
      ".pipeline/schemas/audit-result.schema.json",
      JSON.stringify({
        additionalProperties: true,
        properties: {
          outputs: {
            additionalProperties: true,
            properties: {
              custom: { const: "value" },
              workflowId: { const: "module-hooks" },
            },
            required: ["custom", "workflowId"],
            type: "object",
          },
          status: { const: "pass" },
        },
        required: ["status", "outputs"],
        type: "object",
      })
    );
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
      output_formats: [text]
`,
        profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
        pipeline: `
version: 1
default_workflow: module-hooks
hooks:
  functions:
    audit:
      kind: module
      module: .pipeline/hooks/audit.mjs
      returns:
        schema: .pipeline/schemas/audit-result.schema.json
  on:
    workflow.start:
      - id: audit-generated-defaults
        function: audit
        with:
          custom: value
        failure: fail
        result:
          publish: true
          save_as: hooks.audit
orchestrator:
  profile: orchestrator
workflows:
  module-hooks:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
      },
      project
    );
    const events: PipelineRuntimeEvent[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ a: "ok" }),
      reporter: (event) => events.push(event),
      task: "module hook task",
      workflowId: "module-hooks",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "workflow.start",
          functionId: "audit",
          hookId: "audit-generated-defaults",
          outputs: {
            custom: "value",
            task: "module hook task",
            workflowId: "module-hooks",
          },
          status: "pass",
          summary: "Generated defaults are clean for module-hooks",
          type: "hook.result",
          workflowId: "module-hooks",
        }),
      ])
    );
  });

  it("runs command hook functions with JSON input and result files", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: command-hooks
hooks:
  functions:
    publish:
      kind: command
      command: [node, .pipeline/hooks/publish.mjs]
      trusted: true
      protocol:
        input: file
        result: file
  on:
    node.finish:
      - id: publish-node-summary
        function: publish
        where:
          node: a
        failure: ignore
        result:
          publish: true
          save_as: hooks.publish
          pass_to: downstream
orchestrator:
  profile: orchestrator
workflows:
  command-hooks:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });
    mockExeca.mockImplementationOnce((_command, _args, options) => {
      const env = options?.env as Record<string, string>;
      expect(env.PIPELINE_HOOK_INPUT).toBeTruthy();
      expect(env.PIPELINE_HOOK_RESULT).toBeTruthy();
      const payload = JSON.parse(readFileSync(env.PIPELINE_HOOK_INPUT, "utf8"));
      expect(payload.node.id).toBe("a");
      writeFileSync(
        env.PIPELINE_HOOK_RESULT,
        JSON.stringify({
          outputs: { messageId: "msg_123" },
          status: "pass",
          summary: "Published node summary",
        })
      );
      return { exitCode: 0, stdout: "ignored", stderr: "" };
    });
    const events: PipelineRuntimeEvent[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ a: "ok" }),
      reporter: (event) => events.push(event),
      task: "command hook task",
      workflowId: "command-hooks",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "node.finish",
          functionId: "publish",
          hookId: "publish-node-summary",
          nodeId: "a",
          outputs: { messageId: "msg_123" },
          status: "pass",
          summary: "Published node summary",
          type: "hook.result",
          workflowId: "command-hooks",
        }),
      ])
    );
  });

  it("emits structured lifecycle events for workflow, hooks, nodes, agents, gates, and artifacts", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
  producer:
    runner: opencode
    instructions: { inline: Produce artifact }
`,
      pipeline: `
version: 1
default_workflow: lifecycle
hooks:
  functions:
    announce:
      kind: command
      command: [hook-bin]
      trusted: true
  on:
    workflow.start:
      - id: announce
        function: announce
        failure: fail
orchestrator:
  profile: orchestrator
workflows:
  lifecycle:
    nodes:
      - id: produce
        kind: agent
        profile: producer
        artifacts:
          - path: out/result.txt
        gates:
          - id: command-check
            kind: command
            command: [check-bin, "{{task}}"]
`,
    });
    mockExeca.mockImplementation(commandHookSuccess("ok"));
    const events: Record<string, unknown>[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        writeProjectFile(project, "out/result.txt", "artifact");
        return { exitCode: 0, stdout: `${plan.nodeId} ok` };
      },
      reporter: (event) => events.push(event),
      task: "lifecycle task",
      workflowId: "lifecycle",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edges: [],
          nodes: [
            expect.objectContaining({
              id: "produce",
              kind: "agent",
              needs: [],
              profile: "producer",
              runnerId: "opencode",
            }),
          ],
          type: "workflow.planned",
          workflowId: "lifecycle",
        }),
        expect.objectContaining({
          nodeIds: ["produce"],
          type: "workflow.start",
          workflowId: "lifecycle",
        }),
        expect.objectContaining({
          event: "workflow.start",
          hookId: "announce",
          required: true,
          type: "hook.start",
          workflowId: "lifecycle",
        }),
        expect.objectContaining({
          event: "workflow.start",
          hookId: "announce",
          passed: true,
          required: true,
          type: "hook.finish",
          workflowId: "lifecycle",
        }),
        expect.objectContaining({
          attempt: 1,
          nodeId: "produce",
          profile: "producer",
          runnerId: "opencode",
          type: "node.start",
        }),
        expect.objectContaining({
          attempt: 1,
          nodeId: "produce",
          profile: "producer",
          runnerId: "opencode",
          type: "agent.start",
        }),
        expect.objectContaining({
          attempt: 1,
          nodeId: "produce",
          output: "produce ok",
          type: "node.output.recorded",
        }),
        expect.objectContaining({
          attempt: 1,
          nodeId: "produce",
          profile: "producer",
          runnerId: "opencode",
          type: "agent.finish",
        }),
        expect.objectContaining({
          gateId: "command-check",
          kind: "command",
          nodeId: "produce",
          type: "gate.start",
        }),
        expect.objectContaining({
          gateId: "command-check",
          kind: "command",
          nodeId: "produce",
          passed: true,
          type: "gate.finish",
        }),
        expect.objectContaining({
          nodeId: "produce",
          path: "out/result.txt",
          required: true,
          type: "artifact.check.start",
        }),
        expect.objectContaining({
          nodeId: "produce",
          passed: true,
          path: "out/result.txt",
          required: true,
          type: "artifact.check.finish",
        }),
        expect.objectContaining({
          attempt: 1,
          exitCode: 0,
          nodeId: "produce",
          status: "passed",
          type: "node.finish",
        }),
        expect.objectContaining({
          outcome: "PASS",
          type: "workflow.finish",
          workflowId: "lifecycle",
        }),
      ])
    );
    const indexOf = (type: string) => events.findIndex((e) => e.type === type);
    expect(indexOf("workflow.planned")).toBeLessThan(indexOf("workflow.start"));
    expect(indexOf("workflow.start")).toBeLessThan(indexOf("hook.start"));
    expect(indexOf("hook.start")).toBeLessThan(indexOf("hook.finish"));
    expect(indexOf("node.start")).toBeLessThan(indexOf("agent.start"));
    expect(indexOf("agent.start")).toBeLessThan(indexOf("agent.finish"));
    expect(indexOf("agent.finish")).toBeLessThan(
      indexOf("node.output.recorded")
    );
    expect(indexOf("agent.finish")).toBeLessThan(indexOf("gate.start"));
    expect(indexOf("gate.start")).toBeLessThan(indexOf("gate.finish"));
    expect(indexOf("artifact.check.start")).toBeLessThan(
      indexOf("artifact.check.finish")
    );
    expect(indexOf("node.finish")).toBeLessThan(indexOf("workflow.finish"));
  });

  it("returns a structured cancelled outcome and does not schedule dependent nodes after abort", async () => {
    const project = tempProject();
    const controller = new AbortController();
    const events: Record<string, unknown>[] = [];
    const seen: string[] = [];

    const result = await runPipelineFromConfig({
      config: baseConfig(),
      executor: (plan) => {
        seen.push(plan.nodeId);
        controller.abort();
        return { exitCode: 0, stdout: "aborted after first node" };
      },
      reporter: (event) => events.push(event),
      signal: controller.signal,
      task: "cancel",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { signal: AbortSignal });

    expect(result.outcome).toBe("CANCELLED");
    expect(seen).toEqual(["a"]);
    expect(result.nodes.map((node) => node.nodeId)).toEqual(["a"]);
    expect(result.failureDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.arrayContaining([
            expect.stringMatching(CANCEL_PATTERN),
          ]),
          reason: expect.stringMatching(CANCEL_PATTERN),
        }),
      ])
    );
    expect(result.gates).toEqual([]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "CANCELLED",
          type: "workflow.finish",
          workflowId: "default",
        }),
      ])
    );
  });

  it("passes AbortSignal to the default agent executor subprocess", async () => {
    const project = tempProject();
    const controller = new AbortController();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  agent:
    type: command
    command: agent-bin
    args: ["{{prompt}}"]
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  agent:
    runner: agent
    instructions: { inline: Run the agent }
    output: { format: text }
`,
      pipeline: `
version: 1
default_workflow: signal-agent
orchestrator:
  profile: agent
workflows:
  signal-agent:
    nodes:
      - id: agent-node
        kind: agent
        profile: agent
`,
    });
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    const result = await runPipelineFromConfig({
      config,
      signal: controller.signal,
      task: "signal",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(mockExeca).toHaveBeenCalledWith(
      "agent-bin",
      expect.any(Array),
      expect.objectContaining({ cancelSignal: controller.signal })
    );
  });

  it("passes AbortSignal to execa-backed command hooks, command nodes, command gates, and builtins", async () => {
    const project = tempProject();
    const controller = new AbortController();
    process.env.PIPELINE_TEST_COMMAND = "test-bin";
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
`,
      pipeline: `
version: 1
default_workflow: signal-flow
hooks:
  functions:
    start-hook:
      kind: command
      command: [hook-bin]
      trusted: true
  on:
    workflow.start:
      - id: start-hook
        function: start-hook
        failure: fail
orchestrator:
  profile: orchestrator
workflows:
  signal-flow:
    nodes:
      - id: command-node
        kind: command
        command: [command-bin]
        gates:
          - id: command-gate
            kind: command
            command: [gate-bin]
          - id: builtin-gate
            kind: builtin
            builtin: test
`,
    });
    mockExeca.mockImplementation(commandHookSuccess("ok"));

    const result = await runPipelineFromConfig({
      config,
      signal: controller.signal,
      task: "signal",
      workflowId: "signal-flow",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { signal: AbortSignal });

    expect(result.outcome).toBe("PASS");
    for (const command of ["hook-bin", "command-bin", "gate-bin", "test-bin"]) {
      expect(mockExeca).toHaveBeenCalledWith(
        command,
        expect.any(Array),
        expect.objectContaining({ cancelSignal: controller.signal })
      );
    }
  });

  it("returns CANCELLED when an execa-backed command node is aborted", async () => {
    const project = tempProject();
    const controller = new AbortController();
    const events: Record<string, unknown>[] = [];
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
`,
      pipeline: `
version: 1
default_workflow: cancel-flow
orchestrator:
  profile: orchestrator
workflows:
  cancel-flow:
    nodes:
      - id: wait
        kind: command
        command: [wait-bin]
      - id: dependent
        kind: command
        command: [dependent-bin]
        needs: [wait]
`,
    });

    mockExeca.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: { cancelSignal?: AbortSignal }
      ) =>
        new Promise((_resolve, reject) => {
          options.cancelSignal?.addEventListener("abort", () => {
            reject(
              Object.assign(new Error("cancelled"), {
                exitCode: 1,
                stdout: "started",
              })
            );
          });
          controller.abort();
        })
    );

    const result = await runPipelineFromConfig({
      config,
      reporter: (event) => events.push(event),
      signal: controller.signal,
      task: "cancel",
      workflowId: "cancel-flow",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { signal: AbortSignal });

    expect(result.outcome).toBe("CANCELLED");
    expect(result.nodes.map((node) => node.nodeId)).toEqual(["wait"]);
    expect(mockExeca).toHaveBeenCalledWith(
      "wait-bin",
      expect.any(Array),
      expect.objectContaining({ cancelSignal: controller.signal })
    );
    expect(mockExeca).not.toHaveBeenCalledWith(
      "dependent-bin",
      expect.any(Array),
      expect.any(Object)
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "CANCELLED",
          type: "workflow.finish",
          workflowId: "cancel-flow",
        }),
      ])
    );
  });
});
