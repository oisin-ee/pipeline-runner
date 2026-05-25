import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePipelineConfigParts } from "../src/mastra/config.js";
import type { RunnerLaunchPlan } from "../src/mastra/runner.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
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
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    rules: [test-first]
    skills: [research]
    mcp_servers: [docs]
    tools: [read]
  a:
    runner: codex
    instructions: { inline: Agent A }
    rules: [test-first]
    skills: [research]
    mcp_servers: [docs]
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
    expect(launchText).toContain("command: node");
    expect(launchText).toContain("mcp_servers.docs.command");
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
});
