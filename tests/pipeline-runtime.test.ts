import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePipelineConfigParts } from "../src/config.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";
import type { RunnerLaunchPlan } from "../src/runner.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
const tempDirs: string[] = [];
const originalPipelineTestCommand = process.env.PIPELINE_TEST_COMMAND;
const CANCEL_PATTERN = /cancel/i;

afterEach(() => {
  vi.clearAllMocks();
  if (originalPipelineTestCommand === undefined) {
    delete process.env.PIPELINE_TEST_COMMAND;
  } else {
    process.env.PIPELINE_TEST_COMMAND = originalPipelineTestCommand;
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
    expect(seen).toHaveLength(2);
    expect(seen[0].args.join("\n")).toContain("Node: a");
    expect(seen[1].args.join("\n")).toContain("Node: b");
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

    expect(started).toEqual(["start", "left", "right"]);
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
    expect(indexOf("workflow.start")).toBeLessThan(indexOf("hook.start"));
    expect(indexOf("hook.start")).toBeLessThan(indexOf("hook.finish"));
    expect(indexOf("node.start")).toBeLessThan(indexOf("agent.start"));
    expect(indexOf("agent.start")).toBeLessThan(indexOf("agent.finish"));
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
