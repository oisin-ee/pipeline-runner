import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePipelineConfigParts } from "../src/config.js";
import {
  type PipelineRuntimeEvent,
  runPipelineFromConfig,
} from "../src/pipeline-runtime.js";
import type { RunnerLaunchPlan } from "../src/runner.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const gitMock = vi.hoisted(() => {
  interface GitStatusResult {
    files: { path: string }[];
  }
  const client = {
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
  return {
    client,
    simpleGit: vi.fn((options?: { baseDir?: string }) => ({
      raw: client.raw,
      revparse: client.revparse,
      status: () => client.status(options),
    })),
  };
});

vi.mock("simple-git", () => ({
  default: gitMock.simpleGit,
}));

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
const tempDirs: string[] = [];
const originalPipelineTestCommand = process.env.PIPELINE_TEST_COMMAND;
const originalPipelineSemgrepCommand = process.env.PIPELINE_SEMGREP_COMMAND;
const CANCEL_PATTERN = /cancel/i;
const LINE_SPLIT_RE = /\r?\n/;
const RUN_CHILD_BRANCH_RE = /^run-[0-9a-f-]+\/child$/;
const RUN_ID_TOKEN = `$${"{runId}"}`;
const NODE_ID_TOKEN = `$${"{nodeId}"}`;

beforeEach(() => {
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
  codex:
    type: codex
    command: codex
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
    runner: codex
    instructions: { inline: Orchestrate }
    tools: []
  a:
    runner: codex
    instructions: { inline: Agent A }
    output: { format: text }
  b:
    runner: codex
    instructions: { inline: Agent B }
    output: { format: text }
  structured:
    runner: codex
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

function setWorkflowNodeWorktreeRoot(
  config: ReturnType<typeof baseConfig>,
  workflowId: string,
  nodeId: string,
  worktreeRoot: string
): void {
  const node = config.workflows[workflowId].nodes.find(
    (candidate) => candidate.id === nodeId
  );
  if (!node) {
    throw new Error(`Missing node ${workflowId}.${nodeId}`);
  }
  (node as { worktree_root?: string }).worktree_root = worktreeRoot;
}

function setParallelWorkflowChildWorktreeRoot(
  config: ReturnType<typeof baseConfig>,
  workflowId: string,
  parallelNodeId: string,
  childNodeId: string,
  worktreeRoot: string
): void {
  const parallelNode = config.workflows[workflowId].nodes.find(
    (candidate) => candidate.id === parallelNodeId
  );
  if (!parallelNode || parallelNode.kind !== "parallel") {
    throw new Error(`Missing parallel node ${workflowId}.${parallelNodeId}`);
  }
  const child = parallelNode.nodes.find(
    (candidate) => candidate.id === childNodeId
  );
  if (!child) {
    throw new Error(`Missing child node ${parallelNodeId}.${childNodeId}`);
  }
  (child as { worktree_root?: string }).worktree_root = worktreeRoot;
}

function gitRawCommands(): string[][] {
  return gitMock.client.raw.mock.calls.map((call) =>
    call.flatMap((part) =>
      Array.isArray(part) ? part.map((value) => String(value)) : [String(part)]
    )
  );
}

function workflowChildOutput(input: {
  baseSha?: string;
  branch?: string | null;
  nodeId?: string;
  status?: "PASS" | "FAIL";
  workflowId?: string;
  worktreePath?: string | null;
}): string {
  const nodeId = input.nodeId ?? "child-agent";
  return JSON.stringify({
    baseSha: input.baseSha ?? "base-sha",
    branch: input.branch ?? `run-merge/${nodeId}`,
    nodeResults: [{ nodeId, status: "passed" }],
    status: input.status ?? "PASS",
    worktreePath:
      input.worktreePath === undefined
        ? `/tmp/pipeline-runtime-${nodeId}`
        : input.worktreePath,
    workflowId: input.workflowId ?? `${nodeId}-flow`,
  });
}

function mergeReport(
  result: Awaited<ReturnType<typeof runPipelineFromConfig>>
) {
  const mergeNode = result.nodes.find((node) => node.nodeId === "merge");
  if (!mergeNode) {
    throw new Error("Expected merge node result");
  }
  if (mergeNode.output === "") {
    throw new Error("merge node should output MergeReport JSON");
  }
  return JSON.parse(mergeNode.output);
}

function epicDrainLikeConfig() {
  return parsePipelineConfigParts({
    runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text, json_schema]
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    tools: []
  research:
    runner: codex
    instructions: { inline: Research the epic and sub-tickets. }
    output: { format: text }
  router:
    runner: codex
    instructions:
      inline: "Route sub-tickets into test, frontend, backend, and k8s tracks."
    output:
      format: json_schema
      schema_path: schemas/epic-plan.schema.json
  worker:
    runner: codex
    instructions: { inline: Implement only the sub-tickets assigned to this track. }
    output: { format: text }
  thermo-nuclear-review:
    runner: codex
    instructions: { inline: Review the integration branch and emit a verdict. }
    output:
      format: json_schema
      schema_path: schemas/review.schema.json
`,
    pipeline: `
version: 1
default_workflow: epic-drain
orchestrator:
  profile: orchestrator
workflows:
  epic-drain:
    nodes:
      - id: research
        kind: agent
        profile: research
      - id: plan
        kind: agent
        profile: router
        needs: [research]
      - id: implement
        kind: parallel
        needs: [plan]
        nodes:
          - id: test
            kind: workflow
            workflow: test-track
            worktree_root: .pipeline/runs/\${runId}/test
          - id: frontend
            kind: workflow
            workflow: frontend-track
            worktree_root: .pipeline/runs/\${runId}/frontend
          - id: backend
            kind: workflow
            workflow: backend-track
            worktree_root: .pipeline/runs/\${runId}/backend
          - id: k8s
            kind: workflow
            workflow: k8s-track
            worktree_root: .pipeline/runs/\${runId}/k8s
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [implement]
      - id: review
        kind: agent
        profile: thermo-nuclear-review
        needs: [merge]
        gates:
          - id: review-verdict
            kind: verdict
            target: stdout
  test-track:
    nodes:
      - id: test-worker
        kind: agent
        profile: worker
  frontend-track:
    nodes:
      - id: frontend-worker
        kind: agent
        profile: worker
  backend-track:
    nodes:
      - id: backend-worker
        kind: agent
        profile: worker
  k8s-track:
    nodes:
      - id: k8s-worker
        kind: agent
        profile: worker
`,
  });
}

function writeEpicDrainLikeSchemas(project: string): void {
  writeProjectFile(
    project,
    "schemas/epic-plan.schema.json",
    JSON.stringify({
      additionalProperties: false,
      properties: {
        backend: { type: "array" },
        frontend: { type: "array" },
        k8s: { type: "array" },
        rationale: { type: "string" },
        test: { type: "array" },
      },
      required: ["test", "frontend", "backend", "k8s"],
      type: "object",
    })
  );
  writeProjectFile(
    project,
    "schemas/review.schema.json",
    JSON.stringify({
      additionalProperties: true,
      properties: {
        verdict: { enum: ["PASS", "FAIL"] },
      },
      required: ["verdict"],
      type: "object",
    })
  );
}

function epicPlanOutput(
  overrides: Partial<
    Record<"backend" | "frontend" | "k8s" | "test", string>
  > = {}
): string {
  return JSON.stringify({
    backend: [
      {
        id: overrides.backend ?? "PIPE-31.backend",
        rationale: "server-side change",
        title: "Backend API work",
      },
    ],
    frontend: [
      {
        id: overrides.frontend ?? "PIPE-31.frontend",
        rationale: "browser UI change",
        title: "Frontend UI work",
      },
    ],
    k8s: [
      {
        id: overrides.k8s ?? "PIPE-31.k8s",
        rationale: "deployment manifest change",
        title: "Kubernetes deployment work",
      },
    ],
    rationale: "Each sub-ticket is assigned to exactly one fixed track.",
    test: [
      {
        id: overrides.test ?? "PIPE-31.test",
        rationale: "test harness change",
        title: "Runtime test coverage",
      },
    ],
  });
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

  it("passes workflow-node task context into nested workflow execution", async () => {
    const project = tempProject();
    const config = baseConfig(`
  child-flow:
    nodes:
      - id: child-agent
        kind: agent
        profile: a
`);
    config.workflows.default.nodes = [
      {
        id: "child",
        kind: "workflow",
        task_context: {
          id: "PIPE-41.8",
          title: "Resolved child ticket",
          acceptance_criteria: [
            { id: "1", text: "Nested agents receive child context." },
          ],
        },
        workflow: "child-flow",
      } as (typeof config.workflows.default.nodes)[number],
    ];
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

    const prompt = seen
      .find((plan) => plan.nodeId === "child-agent")
      ?.args.join("\n");
    expect(prompt).toContain("ID: PIPE-41.8");
    expect(prompt).toContain("Title: Resolved child ticket");
    expect(prompt).toContain("- 1: Nested agents receive child context.");
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
  codex:
    type: codex
    command: codex
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
mcp_servers:
  docs:
    command: node
    args: ["docs-server.js"]
    env: { DOCS_TOKEN: test-token }
  memory:
    url: https://memory-mcp.momokaya.ee/mcp/
    headers:
      X-Memory-Region: eu
  secure-memory:
    url: https://memory-mcp.momokaya.ee/mcp/
    bearer_token_env_var: MEMORY_MCP_TOKEN
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    rules: [test-first]
    skills: [research]
    mcp_servers: [docs, memory, secure-memory]
    tools: [read]
  a:
    runner: codex
    instructions: { inline: Agent A }
    rules: [test-first]
    skills: [research]
    mcp_servers: [docs, memory, secure-memory]
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
    expect(launchText).toContain("transport: stdio");
    expect(launchText).toContain("command: node");
    expect(launchText).toContain("mcp_servers.docs.command");
    expect(launchText).toContain("transport: http");
    expect(launchText).toContain("url: https://memory-mcp.momokaya.ee/mcp/");
    expect(launchText).toContain("headers: X-Memory-Region");
    expect(launchText).toContain("bearer_token_env_var: MEMORY_MCP_TOKEN");
    expect(launchText).toContain("mcp_servers.memory.url");
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
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    tools: []
  a:
    runner: codex
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: retry-observability
hooks:
  announce:
    event: workflow.start
    kind: command
    command: [hook-bin]
    required: true
orchestrator:
  profile: orchestrator
workflows:
  retry-observability:
    hooks: [announce]
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
      .mockResolvedValueOnce({ exitCode: 0, stdout: "hook", stderr: "" })
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
      executor: executor({ checked: "done" }),
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
      ["semgrep", "scan", "--config=p/ci", "--error", "."],
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
    const timeouts: number[] = [];

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

  it("validates JSON schema gates against the final Codex message instead of raw JSONL events", async () => {
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
    const codexJsonl = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        item: {
          text: JSON.stringify({ verdict: "PASS" }),
          type: "agent_message",
        },
        type: "item.completed",
      }),
    ].join("\n");

    const result = await runPipelineFromConfig({
      config,
      executor: () => ({ exitCode: 0, stdout: codexJsonl }),
      task: "schema",
      workflowId: "structured-flow",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(result.nodes[0].output).toBe('{"verdict":"PASS"}');
    expect(result.nodes[0].evidence).toContain(
      "normalized runner output from codex JSONL"
    );
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
      runnerId: "codex",
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

  it("runs a workflow node with inherited task context and dependency outputs", async () => {
    const project = tempProject();
    const seen: RunnerLaunchPlan[] = [];
    const config = baseConfig(`
  parent:
    nodes:
      - id: prepare
        kind: agent
        profile: a
      - id: child
        kind: workflow
        workflow: child-flow
        needs: [prepare]
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: b
`);

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return { exitCode: 0, stdout: `${plan.nodeId} output` };
      },
      task: "nested workflow",
      taskContext: {
        acceptanceCriteria: [{ id: "AC1", text: "Nested task context" }],
        id: "PIPE-31.1",
        title: "Workflow node",
      },
      workflowId: "parent",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(seen.map((plan) => plan.nodeId)).toEqual(["prepare", "nested"]);
    const nestedPrompt = seen[1].args.join("\n");
    expect(nestedPrompt).toContain("Workflow: child-flow");
    expect(nestedPrompt).toContain("ID: PIPE-31.1");
    expect(nestedPrompt).toContain("## prepare\nprepare output");
    expect(result.nodes.find((node) => node.nodeId === "child")?.output).toBe(
      JSON.stringify({
        baseSha: null,
        branch: null,
        nodeResults: [{ nodeId: "nested", status: "passed" }],
        status: "PASS",
        worktreePath: null,
        workflowId: "child-flow",
      })
    );
  });

  it("propagates workflow node child failure to the parent node", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: child
        kind: workflow
        workflow: child-flow
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: a
`);

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ nested: "__FAIL__" }),
      task: "nested workflow",
      workflowId: "parent",
      worktreePath: project,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.nodes).toEqual([
      expect.objectContaining({
        exitCode: 1,
        nodeId: "child",
        status: "failed",
      }),
    ]);
    expect(result.nodes[0].evidence).toContain("workflow 'child-flow' failed");
  });

  it("reuses the parent executor for workflow node children", async () => {
    const project = tempProject();
    const seen: string[] = [];
    const config = baseConfig(`
  parent:
    nodes:
      - id: child
        kind: workflow
        workflow: child-flow
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: a
`);

    await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan.nodeId);
        return { exitCode: 0, stdout: "ok" };
      },
      task: "nested workflow",
      workflowId: "parent",
      worktreePath: project,
    });

    expect(seen).toEqual(["nested"]);
  });

  it("emits child workflow reporter events with parent node context", async () => {
    const project = tempProject();
    const events: Record<string, unknown>[] = [];
    const config = baseConfig(`
  parent:
    nodes:
      - id: child
        kind: workflow
        workflow: child-flow
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: a
`);

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => ({ exitCode: 0, stdout: `${plan.nodeId} ok` }),
      reporter: (event) => events.push(event),
      task: "nested workflow",
      workflowId: "parent",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentNodeId: "child",
          type: "workflow.start",
          workflowId: "child-flow",
        }),
        expect.objectContaining({
          nodes: [
            expect.objectContaining({
              id: "child.nested",
              kind: "agent",
            }),
          ],
          parentNodeId: "child",
          type: "workflow.planned",
          workflowId: "child-flow",
        }),
        expect.objectContaining({
          nodeId: "child.nested",
          parentNodeId: "child",
          type: "agent.start",
        }),
        expect.objectContaining({
          outcome: "PASS",
          parentNodeId: "child",
          type: "workflow.finish",
          workflowId: "child-flow",
        }),
      ])
    );
  });

  it("creates a workflow-node worktree from a pinned base SHA, runs the child there, and removes it on success", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: child
        kind: workflow
        workflow: child-flow
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: a
`);
    setWorkflowNodeWorktreeRoot(
      config,
      "parent",
      "child",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    gitMock.client.revparse.mockResolvedValue("base-sha-123");
    const seen: RunnerLaunchPlan[] = [];
    const resolvedWorktreePath = resolve(
      project,
      "worktrees",
      "run-123",
      "child"
    );

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return { exitCode: 0, stdout: "nested ok" };
      },
      runId: "run-123",
      task: "nested workflow",
      workflowId: "parent",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

    expect(result.outcome).toBe("PASS");
    expect(gitMock.client.revparse).toHaveBeenCalledTimes(1);
    expect(gitMock.client.revparse).toHaveBeenCalledWith(["HEAD"]);
    expect(gitRawCommands()).toContainEqual([
      "worktree",
      "add",
      "-b",
      "run-123/child",
      resolvedWorktreePath,
      "base-sha-123",
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(resolvedWorktreePath);
    expect(gitRawCommands()).toContainEqual([
      "worktree",
      "remove",
      "--force",
      resolvedWorktreePath,
    ]);
    expect(JSON.parse(result.nodes[0].output)).toMatchObject({
      baseSha: "base-sha-123",
      branch: "run-123/child",
      worktreePath: resolvedWorktreePath,
    });
  });

  it("generates a run id for workflow worktree templates when no run id is provided", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: child
        kind: workflow
        workflow: child-flow
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: a
`);
    setWorkflowNodeWorktreeRoot(
      config,
      "parent",
      "child",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    gitMock.client.revparse.mockResolvedValue("generated-base");

    const result = await runPipelineFromConfig({
      config,
      executor: () => ({ exitCode: 0, stdout: "nested ok" }),
      task: "generated run",
      workflowId: "parent",
      worktreePath: project,
    });
    const output = JSON.parse(result.nodes[0].output);

    expect(result.outcome).toBe("PASS");
    expect(output.branch).toMatch(RUN_CHILD_BRANCH_RE);
    expect(output.branch).not.toBe("run/child");
    expect(output.worktreePath).toBe(
      resolve(project, "worktrees", output.branch.split("/")[0], "child")
    );
    expect(gitRawCommands()).toContainEqual([
      "worktree",
      "add",
      "-b",
      output.branch,
      output.worktreePath,
      "generated-base",
    ]);
  });

  it("leaves a workflow-node worktree on failure and emits an absolute inspection path", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: child
        kind: workflow
        workflow: child-flow
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: a
`);
    setWorkflowNodeWorktreeRoot(
      config,
      "parent",
      "child",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    gitMock.client.revparse.mockResolvedValue("base-sha-fail");
    const resolvedWorktreePath = resolve(
      project,
      "worktrees",
      "run-fail",
      "child"
    );

    const result = await runPipelineFromConfig({
      config,
      executor: executor({ nested: "__FAIL__" }),
      runId: "run-fail",
      task: "nested workflow",
      workflowId: "parent",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

    expect(result.outcome).toBe("FAIL");
    expect(gitRawCommands()).toContainEqual([
      "worktree",
      "add",
      "-b",
      "run-fail/child",
      resolvedWorktreePath,
      "base-sha-fail",
    ]);
    expect(gitRawCommands()).not.toContainEqual([
      "worktree",
      "remove",
      resolvedWorktreePath,
    ]);
    expect(result.nodes[0].evidence.join("\n")).toContain(
      `cd ${resolvedWorktreePath}`
    );
  });

  it("does not touch git worktrees and emits null worktree metadata when workflow nodes omit worktree_root", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: child
        kind: workflow
        workflow: child-flow
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: a
`);
    const seen: RunnerLaunchPlan[] = [];

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.push(plan);
        return { exitCode: 0, stdout: "nested ok" };
      },
      task: "nested workflow",
      workflowId: "parent",
      worktreePath: project,
    });

    expect(result.outcome).toBe("PASS");
    expect(seen[0].cwd).toBe(project);
    expect(gitMock.client.revparse).not.toHaveBeenCalled();
    expect(gitRawCommands()).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["worktree", "add"]),
        expect.arrayContaining(["worktree", "remove"]),
      ])
    );
    expect(JSON.parse(result.nodes[0].output)).toMatchObject({
      baseSha: null,
      branch: null,
      worktreePath: null,
    });
  });

  it("pins the base SHA at workflow start when the plan contains a worktree-backed workflow node", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: prepare
        kind: agent
        profile: a
      - id: child
        kind: workflow
        workflow: child-flow
        needs: [prepare]
  child-flow:
    nodes:
      - id: nested
        kind: agent
        profile: b
`);
    setWorkflowNodeWorktreeRoot(
      config,
      "parent",
      "child",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    gitMock.client.revparse.mockResolvedValue("start-pinned-base");
    const run = vi.fn((plan: RunnerLaunchPlan) => ({
      exitCode: 0,
      stdout: `${plan.nodeId} ok`,
    }));

    const result = await runPipelineFromConfig({
      config,
      executor: run,
      runId: "run-start",
      task: "start pin",
      workflowId: "parent",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

    expect(result.outcome).toBe("PASS");
    expect(gitMock.client.revparse).toHaveBeenCalledTimes(1);
    expect(gitMock.client.revparse.mock.invocationCallOrder[0]).toBeLessThan(
      run.mock.invocationCallOrder[0]
    );
  });

  it("resolves independent worktree paths for parallel workflow children without mutating process.env", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: workflow
            workflow: left-flow
          - id: right
            kind: workflow
            workflow: right-flow
  left-flow:
    nodes:
      - id: left-agent
        kind: agent
        profile: a
  right-flow:
    nodes:
      - id: right-agent
        kind: agent
        profile: b
`);
    setParallelWorkflowChildWorktreeRoot(
      config,
      "parent",
      "fanout",
      "left",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    setParallelWorkflowChildWorktreeRoot(
      config,
      "parent",
      "fanout",
      "right",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    gitMock.client.revparse.mockResolvedValue("parallel-base");
    const envBefore = { ...process.env };
    const seen = new Map<string, string>();

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => {
        seen.set(plan.nodeId, plan.cwd);
        return { exitCode: 0, stdout: `${plan.nodeId} ok` };
      },
      runId: "run-parallel",
      task: "parallel worktrees",
      workflowId: "parent",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

    expect(result.outcome).toBe("PASS");
    expect(seen.get("left-agent")).toBe(
      resolve(project, "worktrees", "run-parallel", "left")
    );
    expect(seen.get("right-agent")).toBe(
      resolve(project, "worktrees", "run-parallel", "right")
    );
    expect(seen.get("left-agent")).not.toBe(seen.get("right-agent"));
    expect({ ...process.env }).toEqual(envBefore);
  });

  it("pins the base SHA once across multiple workflow-node worktrees", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parent:
    nodes:
      - id: left
        kind: workflow
        workflow: left-flow
      - id: right
        kind: workflow
        workflow: right-flow
        needs: [left]
  left-flow:
    nodes:
      - id: left-agent
        kind: agent
        profile: a
  right-flow:
    nodes:
      - id: right-agent
        kind: agent
        profile: b
`);
    setWorkflowNodeWorktreeRoot(
      config,
      "parent",
      "left",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    setWorkflowNodeWorktreeRoot(
      config,
      "parent",
      "right",
      join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
    );
    gitMock.client.revparse.mockResolvedValue("single-pinned-base");

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => ({ exitCode: 0, stdout: `${plan.nodeId} ok` }),
      runId: "run-pinned",
      task: "pinned base",
      workflowId: "parent",
      worktreePath: project,
    } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

    expect(result.outcome).toBe("PASS");
    expect(gitMock.client.revparse).toHaveBeenCalledTimes(1);
    expect(gitRawCommands()).toEqual(
      expect.arrayContaining([
        [
          "worktree",
          "add",
          "-b",
          "run-pinned/left",
          resolve(project, "worktrees", "run-pinned", "left"),
          "single-pinned-base",
        ],
        [
          "worktree",
          "add",
          "-b",
          "run-pinned/right",
          resolve(project, "worktrees", "run-pinned", "right"),
          "single-pinned-base",
        ],
      ])
    );
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

  it("composes nested parallel and workflow nodes with children output shape", async () => {
    const project = tempProject();
    const config = baseConfig(`
  nested-composition:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: direct
            kind: agent
            profile: a
          - id: nested
            kind: parallel
            nodes:
              - id: child
                kind: workflow
                workflow: child-flow
  child-flow:
    nodes:
      - id: nested-agent
        kind: agent
        profile: b
`);

    const result = await runPipelineFromConfig({
      config,
      executor: (plan) => ({ exitCode: 0, stdout: `${plan.nodeId} output` }),
      task: "nested parallel",
      workflowId: "nested-composition",
      worktreePath: project,
    });

    const fanout = result.nodes.find((node) => node.nodeId === "fanout");
    if (!fanout) {
      throw new Error("Expected fanout container result");
    }
    const fanoutOutput = JSON.parse(fanout.output);
    const nestedOutput = JSON.parse(fanoutOutput.children.nested);
    const workflowOutput = JSON.parse(nestedOutput.children.child);

    expect(result.outcome).toBe("PASS");
    expect(fanoutOutput).toEqual({
      children: {
        direct: "direct output",
        nested: expect.any(String),
      },
    });
    expect(nestedOutput).toEqual({
      children: {
        child: expect.any(String),
      },
    });
    expect(workflowOutput).toEqual({
      baseSha: null,
      branch: null,
      nodeResults: [{ nodeId: "nested-agent", status: "passed" }],
      status: "PASS",
      worktreePath: null,
      workflowId: "child-flow",
    });
  });

  describe("parent epic-drain E2E scenarios", () => {
    it("routes an epic into four fixed worktree tracks, drain-merges PASSed branches in order, and emits a thermo-nuclear review PASS", async () => {
      const project = tempProject();
      writeEpicDrainLikeSchemas(project);
      gitMock.client.revparse.mockResolvedValue("base-epic");
      const seen: RunnerLaunchPlan[] = [];

      const result = await runPipelineFromConfig({
        config: epicDrainLikeConfig(),
        executor: (plan) => {
          seen.push(plan);
          if (plan.nodeId === "plan") {
            return { exitCode: 0, stdout: epicPlanOutput() };
          }
          if (plan.nodeId === "review") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                evidence: ["integration branch reviewed"],
                findings: [],
                verdict: "PASS",
              }),
            };
          }
          return { exitCode: 0, stdout: `${plan.nodeId} PASS` };
        },
        runId: "run-epic",
        task: "PIPE-31 parent epic",
        workflowId: "epic-drain",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("PASS");
      expect(
        gitRawCommands().filter(
          (command) => command[0] === "worktree" && command[1] === "add"
        )
      ).toEqual([
        [
          "worktree",
          "add",
          "-b",
          "run-epic/test",
          resolve(project, ".pipeline", "runs", "run-epic", "test"),
          "base-epic",
        ],
        [
          "worktree",
          "add",
          "-b",
          "run-epic/frontend",
          resolve(project, ".pipeline", "runs", "run-epic", "frontend"),
          "base-epic",
        ],
        [
          "worktree",
          "add",
          "-b",
          "run-epic/backend",
          resolve(project, ".pipeline", "runs", "run-epic", "backend"),
          "base-epic",
        ],
        [
          "worktree",
          "add",
          "-b",
          "run-epic/k8s",
          resolve(project, ".pipeline", "runs", "run-epic", "k8s"),
          "base-epic",
        ],
      ]);
      expect(
        gitRawCommands().filter((command) => command[0] === "merge")
      ).toEqual([
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-epic/test",
        ],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-epic/frontend",
        ],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-epic/backend",
        ],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-epic/k8s",
        ],
      ]);
      expect(mergeReport(result)).toMatchObject({
        conflicts: [],
        merged: [
          { branch: "run-epic/test", id: "test" },
          { branch: "run-epic/frontend", id: "frontend" },
          { branch: "run-epic/backend", id: "backend" },
          { branch: "run-epic/k8s", id: "k8s" },
        ],
      });
      expect(result.gates).toContainEqual(
        expect.objectContaining({
          gateId: "review-verdict",
          passed: true,
        })
      );

      const promptByTrack = new Map(
        seen
          .filter((plan) => plan.nodeId.endsWith("-worker"))
          .map((plan) => [
            plan.nodeId.replace("-worker", ""),
            plan.args.join("\n"),
          ])
      );
      expect(promptByTrack.get("test")).toContain("PIPE-31.test");
      expect(promptByTrack.get("test")).not.toContain("PIPE-31.frontend");
      expect(promptByTrack.get("frontend")).toContain("PIPE-31.frontend");
      expect(promptByTrack.get("frontend")).not.toContain("PIPE-31.backend");
      expect(promptByTrack.get("backend")).toContain("PIPE-31.backend");
      expect(promptByTrack.get("backend")).not.toContain("PIPE-31.k8s");
      expect(promptByTrack.get("k8s")).toContain("PIPE-31.k8s");
      expect(promptByTrack.get("k8s")).not.toContain("PIPE-31.test");
    });

    it("reports package.json drain-merge conflicts with branch and worktree inspection metadata", async () => {
      const project = tempProject();
      writeEpicDrainLikeSchemas(project);
      gitMock.client.revparse.mockResolvedValue("base-conflict");
      gitMock.client.raw.mockImplementation((...commands) => {
        const command = commands.flatMap((part) =>
          Array.isArray(part) ? part.map(String) : [String(part)]
        );
        if (
          command[0] === "merge" &&
          command.at(-1) === "run-conflict/frontend"
        ) {
          return Promise.reject(new Error("package.json conflict"));
        }
        if (
          command[0] === "diff" &&
          command.slice(1).join(" ") === "--name-only --diff-filter=U"
        ) {
          return Promise.resolve("package.json\n");
        }
        return Promise.resolve("");
      });

      const result = await runPipelineFromConfig({
        config: epicDrainLikeConfig(),
        executor: (plan) => {
          if (plan.nodeId === "plan") {
            return {
              exitCode: 0,
              stdout: epicPlanOutput({
                frontend: "PIPE-31.package-frontend",
                test: "PIPE-31.package-test",
              }),
            };
          }
          return { exitCode: 0, stdout: `${plan.nodeId} touched package.json` };
        },
        runId: "run-conflict",
        task: "PIPE-31 conflict epic",
        workflowId: "epic-drain",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("FAIL");
      expect(result.nodeStates.merge).toMatchObject({
        exitCode: 1,
        status: "failed",
      });
      expect(
        gitRawCommands().filter((command) => command[0] === "merge")
      ).toEqual([
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-conflict/test",
        ],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-conflict/frontend",
        ],
        ["merge", "--abort"],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-conflict/backend",
        ],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-conflict/k8s",
        ],
      ]);
      expect(mergeReport(result).conflicts).toEqual([
        {
          branch: "run-conflict/frontend",
          files: ["package.json"],
          id: "frontend",
          worktreePath: resolve(
            project,
            ".pipeline",
            "runs",
            "run-conflict",
            "frontend"
          ),
        },
      ]);
      expect(
        gitRawCommands().filter(
          (command) => command[0] === "worktree" && command[1] === "remove"
        )
      ).toEqual([]);
    });
  });

  describe("drain-merge builtin", () => {
    it("merges PASS children in parallel declaration order and emits a MergeReport", async () => {
      const project = tempProject();
      const leftWorktree = resolve(project, "worktrees", "run-merge", "left");
      const rightWorktree = resolve(project, "worktrees", "run-merge", "right");
      const config = baseConfig(`
  drain-flow:
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
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
`);

      const result = await runPipelineFromConfig({
        config,
        executor: executor({
          left: workflowChildOutput({
            baseSha: "base-merge",
            branch: "run-merge/left",
            nodeId: "left-agent",
            worktreePath: leftWorktree,
          }),
          right: workflowChildOutput({
            baseSha: "base-merge",
            branch: "run-merge/right",
            nodeId: "right-agent",
            worktreePath: rightWorktree,
          }),
        }),
        runId: "run-merge",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("PASS");
      expect(result.nodeStates.merge).toMatchObject({
        exitCode: 0,
        status: "passed",
      });
      expect(
        gitRawCommands().filter((command) => command[0] === "merge")
      ).toEqual([
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-merge/left",
        ],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-merge/right",
        ],
      ]);
      expect(mergeReport(result)).toEqual({
        baseSha: "base-merge",
        conflicts: [],
        integrationBranch: "runs/integration/run-merge",
        merged: [
          {
            branch: "run-merge/left",
            id: "left",
            worktreePath: leftWorktree,
          },
          {
            branch: "run-merge/right",
            id: "right",
            worktreePath: rightWorktree,
          },
        ],
        skipped: [],
      });
    });

    it("creates the integration branch from baseSha when missing and checks it out when existing", async () => {
      const project = tempProject();
      const config = baseConfig(`
  drain-flow:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: agent
            profile: a
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
`);
      gitMock.client.raw.mockImplementation((...commands) => {
        const command = commands.flatMap((part) =>
          Array.isArray(part) ? part.map(String) : [String(part)]
        );
        if (
          command[0] === "rev-parse" &&
          command.includes("runs/integration/run-missing")
        ) {
          throw new Error("branch missing");
        }
        return Promise.resolve("");
      });

      const missing = await runPipelineFromConfig({
        config,
        executor: executor({
          left: workflowChildOutput({
            baseSha: "base-setup",
            branch: "run-setup/left",
            nodeId: "left-agent",
            worktreePath: resolve(project, "left"),
          }),
        }),
        runId: "run-missing",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(missing.outcome).toBe("PASS");
      expect(gitRawCommands()).toContainEqual([
        "checkout",
        "-b",
        "runs/integration/run-missing",
        "base-setup",
      ]);

      gitMock.client.raw.mockClear();
      const existing = await runPipelineFromConfig({
        config,
        executor: executor({
          left: workflowChildOutput({
            baseSha: "base-setup",
            branch: "run-setup/left",
            nodeId: "left-agent",
            worktreePath: resolve(project, "left"),
          }),
        }),
        runId: "run-existing",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(existing.outcome).toBe("PASS");
      expect(gitRawCommands()).toContainEqual([
        "checkout",
        "runs/integration/run-existing",
      ]);
      expect(gitRawCommands()).not.toContainEqual([
        "checkout",
        "-b",
        "runs/integration/run-existing",
        "base-setup",
      ]);
    });

    it("records conflicts, aborts the conflicted merge, continues later siblings, and exits nonzero", async () => {
      const project = tempProject();
      const config = baseConfig(`
  drain-flow:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: agent
            profile: a
          - id: conflict
            kind: agent
            profile: b
          - id: later
            kind: agent
            profile: a
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
`);
      gitMock.client.raw.mockImplementation((...commands) => {
        const command = commands.flatMap((part) =>
          Array.isArray(part) ? part.map(String) : [String(part)]
        );
        if (command[0] === "merge" && command.at(-1) === "run-merge/conflict") {
          throw new Error("merge conflict");
        }
        if (
          command[0] === "diff" &&
          command.slice(1).join(" ") === "--name-only --diff-filter=U"
        ) {
          return Promise.resolve("src/conflict.ts\npackage.json\n");
        }
        return Promise.resolve("");
      });

      const result = await runPipelineFromConfig({
        config,
        executor: executor({
          conflict: workflowChildOutput({
            baseSha: "base-merge",
            branch: "run-merge/conflict",
            nodeId: "conflict-agent",
            worktreePath: resolve(project, "conflict"),
          }),
          later: workflowChildOutput({
            baseSha: "base-merge",
            branch: "run-merge/later",
            nodeId: "later-agent",
            worktreePath: resolve(project, "later"),
          }),
          left: workflowChildOutput({
            baseSha: "base-merge",
            branch: "run-merge/left",
            nodeId: "left-agent",
            worktreePath: resolve(project, "left"),
          }),
        }),
        runId: "run-merge",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("FAIL");
      expect(result.nodeStates.merge).toMatchObject({
        exitCode: 1,
        status: "failed",
      });
      expect(
        gitRawCommands().filter((command) =>
          ["diff", "merge"].includes(command[0] ?? "")
        )
      ).toEqual([
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-merge/left",
        ],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-merge/conflict",
        ],
        ["diff", "--name-only", "--diff-filter=U"],
        ["merge", "--abort"],
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-merge/later",
        ],
      ]);
      expect(mergeReport(result)).toMatchObject({
        conflicts: [
          {
            branch: "run-merge/conflict",
            files: ["src/conflict.ts", "package.json"],
            id: "conflict",
          },
        ],
        merged: [
          { branch: "run-merge/left", id: "left" },
          { branch: "run-merge/later", id: "later" },
        ],
      });
    });

    it("skips non-PASS children as failed and PASS children without worktree metadata as no-worktree without failing", async () => {
      const project = tempProject();
      const config = baseConfig(`
  drain-flow:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: failed
            kind: agent
            profile: a
          - id: missing
            kind: agent
            profile: b
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
`);

      const result = await runPipelineFromConfig({
        config,
        executor: executor({
          failed: workflowChildOutput({
            branch: "run-merge/failed",
            nodeId: "failed-agent",
            status: "FAIL",
            worktreePath: resolve(project, "failed"),
          }),
          missing: workflowChildOutput({
            branch: null,
            nodeId: "missing-agent",
            status: "PASS",
            worktreePath: null,
          }),
        }),
        runId: "run-merge",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("PASS");
      expect(result.nodeStates.merge).toMatchObject({
        exitCode: 0,
        status: "passed",
      });
      expect(
        gitRawCommands().filter((command) => command[0] === "merge")
      ).toEqual([]);
      expect(mergeReport(result)).toMatchObject({
        conflicts: [],
        merged: [],
        skipped: [
          { id: "failed", reason: "failed", status: "FAIL" },
          { id: "missing", reason: "no-worktree", status: "PASS" },
        ],
      });
    });

    it("runs after a failed parallel workflow child and merges the passing worktree child", async () => {
      const project = tempProject();
      const passedWorktree = resolve(
        project,
        "worktrees",
        "run-drain",
        "passed"
      );
      const failedWorktree = resolve(
        project,
        "worktrees",
        "run-drain",
        "failed"
      );
      const config = baseConfig(`
  drain-flow:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: failed
            kind: workflow
            workflow: failed-flow
          - id: passed
            kind: workflow
            workflow: passed-flow
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
  failed-flow:
    nodes:
      - id: failed-agent
        kind: agent
        profile: a
  passed-flow:
    nodes:
      - id: passed-agent
        kind: agent
        profile: b
`);
      setParallelWorkflowChildWorktreeRoot(
        config,
        "drain-flow",
        "fanout",
        "failed",
        join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
      );
      setParallelWorkflowChildWorktreeRoot(
        config,
        "drain-flow",
        "fanout",
        "passed",
        join(project, "worktrees", RUN_ID_TOKEN, NODE_ID_TOKEN)
      );
      gitMock.client.revparse.mockResolvedValue("base-drain");

      const result = await runPipelineFromConfig({
        config,
        executor: executor({
          "failed-agent": "__FAIL__",
          "passed-agent": "passed ok",
        }),
        runId: "run-drain",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("PASS");
      expect(result.nodeStates.fanout).toMatchObject({
        exitCode: 1,
        status: "failed",
      });
      expect(result.nodeStates.merge).toMatchObject({
        exitCode: 0,
        status: "passed",
      });
      expect(
        gitRawCommands().filter((command) => command[0] === "merge")
      ).toEqual([
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          "drain-merge: merge",
          "run-drain/passed",
        ],
      ]);
      expect(mergeReport(result)).toEqual({
        baseSha: "base-drain",
        conflicts: [],
        integrationBranch: "runs/integration/run-drain",
        merged: [
          {
            branch: "run-drain/passed",
            id: "passed",
            worktreePath: passedWorktree,
          },
        ],
        skipped: [{ id: "failed", reason: "failed", status: "FAIL" }],
      });
      expect(gitRawCommands()).toEqual(
        expect.arrayContaining([
          [
            "worktree",
            "add",
            "-b",
            "run-drain/failed",
            failedWorktree,
            "base-drain",
          ],
          [
            "worktree",
            "add",
            "-b",
            "run-drain/passed",
            passedWorktree,
            "base-drain",
          ],
        ])
      );
    });

    it("detects divergent child baseSha before checkout or merge side effects and exits nonzero", async () => {
      const project = tempProject();
      const config = baseConfig(`
  drain-flow:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: agent
            profile: a
          - id: divergent
            kind: agent
            profile: b
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
`);

      const result = await runPipelineFromConfig({
        config,
        executor: executor({
          divergent: workflowChildOutput({
            baseSha: "other-base",
            branch: "run-merge/divergent",
            nodeId: "divergent-agent",
            worktreePath: resolve(project, "divergent"),
          }),
          left: workflowChildOutput({
            baseSha: "base-merge",
            branch: "run-merge/left",
            nodeId: "left-agent",
            worktreePath: resolve(project, "left"),
          }),
        }),
        runId: "run-merge",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("FAIL");
      expect(
        gitRawCommands().filter((command) =>
          ["checkout", "merge"].includes(command[0] ?? "")
        )
      ).toEqual([]);
      expect(result.nodeStates.merge.evidence).toContain(
        "drain-merge child 'divergent' baseSha other-base diverges from base-merge"
      );
      expect(mergeReport(result)).toEqual({
        baseSha: "base-merge",
        conflicts: [],
        integrationBranch: "runs/integration/run-merge",
        merged: [],
        skipped: [],
      });
    });

    it("uses nonzero report exit code for setup errors", async () => {
      const project = tempProject();
      const config = baseConfig(`
  drain-flow:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: left
            kind: agent
            profile: a
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [fanout]
`);
      gitMock.client.raw.mockImplementation((...commands) => {
        const command = commands.flatMap((part) =>
          Array.isArray(part) ? part.map(String) : [String(part)]
        );
        if (
          command[0] === "checkout" &&
          command.includes("runs/integration/run-setup-error")
        ) {
          throw new Error("cannot create integration branch");
        }
        return Promise.resolve("");
      });

      const result = await runPipelineFromConfig({
        config,
        executor: executor({
          left: workflowChildOutput({
            baseSha: "base-merge",
            branch: "run-merge/left",
            nodeId: "left-agent",
            worktreePath: resolve(project, "left"),
          }),
        }),
        runId: "run-setup-error",
        task: "drain merge",
        workflowId: "drain-flow",
        worktreePath: project,
      } as Parameters<typeof runPipelineFromConfig>[0] & { runId: string });

      expect(result.outcome).toBe("FAIL");
      expect(result.nodeStates.merge).toMatchObject({
        exitCode: 1,
        status: "failed",
      });
      expect(result.nodeStates.merge.evidence).toContain(
        "drain-merge setup-error: cannot create integration branch"
      );
      expect(mergeReport(result)).toEqual({
        baseSha: "base-merge",
        conflicts: [],
        integrationBranch: "runs/integration/run-setup-error",
        merged: [],
        skipped: [],
      });
    });
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

  it("runs hooks with templating and required failure semantics", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    tools: []
  a:
    runner: codex
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  required-start:
    event: node.start
    kind: command
    command: [hook-bin, "{{workflow.id}}", "{{node.id}}", "{{task}}"]
    required: true
orchestrator:
  profile: orchestrator
workflows:
  default:
    hooks: [required-start]
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
      ["default", "a", "hook task"],
      expect.objectContaining({ cwd: project })
    );
    expect(result.agentInvocations).toEqual([]);
  });

  it("dispatches orchestrator workflow hooks before workflow hooks", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
  a:
    runner: codex
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  orchestrator-start:
    event: workflow.start
    kind: command
    command: [hook-bin, orchestrator]
    required: true
  workflow-start:
    event: workflow.start
    kind: command
    command: [hook-bin, workflow]
    required: true
orchestrator:
  profile: orchestrator
  hooks: [orchestrator-start]
workflows:
  default:
    hooks: [orchestrator-start, workflow-start]
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

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
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
  a:
    runner: codex
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  start:
    event: workflow.start
    kind: command
    command: [hook-bin]
    required: true
    trusted: true
    env:
      passthrough: [PATH]
      set: { HOOK_ONLY: "yes" }
    output_limit_bytes: 4
orchestrator:
  profile: orchestrator
  hooks: [start]
workflows:
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    });
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "abcdef", stderr: "" });

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
        env: expect.objectContaining({ GLOBAL_HOOK: "1", HOOK_ONLY: "yes" }),
        extendEnv: false,
        input: expect.stringContaining('"task":"hook payload"'),
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
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
  a:
    runner: codex
    instructions: { inline: Agent A }
`,
      pipeline: `
version: 1
default_workflow: default
hooks:
  start:
    event: workflow.start
    kind: command
    command: [hook-bin]
    required: true
    trusted: false
orchestrator:
  profile: orchestrator
  hooks: [start]
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

  it("emits structured lifecycle events for workflow, hooks, nodes, agents, gates, and artifacts", async () => {
    const project = tempProject();
    const config = parsePipelineConfigParts({
      runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    tools: []
  producer:
    runner: codex
    instructions: { inline: Produce artifact }
`,
      pipeline: `
version: 1
default_workflow: lifecycle
hooks:
  announce:
    event: workflow.start
    kind: command
    command: [hook-bin, "{{workflow.id}}"]
    required: true
orchestrator:
  profile: orchestrator
workflows:
  lifecycle:
    hooks: [announce]
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
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
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
              runnerId: "codex",
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
          runnerId: "codex",
          type: "node.start",
        }),
        expect.objectContaining({
          attempt: 1,
          nodeId: "produce",
          profile: "producer",
          runnerId: "codex",
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
          runnerId: "codex",
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
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    tools: []
`,
      pipeline: `
version: 1
default_workflow: signal-flow
hooks:
  start-hook:
    event: workflow.start
    kind: command
    command: [hook-bin]
    required: true
orchestrator:
  profile: orchestrator
workflows:
  signal-flow:
    hooks: [start-hook]
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
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

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
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: codex
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
