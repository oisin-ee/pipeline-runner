import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePipelineConfigYaml } from "../src/mastra/config.js";
import type { RunnerLaunchPlan } from "../src/mastra/runner.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const mockExeca = vi.mocked(execa);
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
  return parsePipelineConfigYaml(`
version: 1
default_workflow: default
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
agents:
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
workflows:
${extraWorkflow}
  default:
    nodes:
      - id: a
        kind: agent
        agent: a
      - id: b
        kind: agent
        agent: b
        needs: [a]
`);
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

  it("runs parallel nodes concurrently after dependencies are met", async () => {
    const project = tempProject();
    const config = baseConfig(`
  parallel:
    nodes:
      - { id: start, kind: agent, agent: a }
      - { id: left, kind: agent, agent: a, needs: [start] }
      - { id: right, kind: agent, agent: b, needs: [start] }
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
        agent: a
        artifacts:
          - path: out.json
      - id: dependent
        kind: agent
        agent: b
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
        agent: a
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
        agent: structured
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

  it("runs hooks with templating and required failure semantics", async () => {
    const project = tempProject();
    const config = parsePipelineConfigYaml(`
version: 1
default_workflow: default
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      output_formats: [text]
hooks:
  required-start:
    event: node.start
    kind: command
    command: [hook-bin, "{{workflow.id}}", "{{node.id}}", "{{task}}"]
    required: true
agents:
  a:
    runner: codex
    instructions: { inline: Agent A }
workflows:
  default:
    hooks: [required-start]
    nodes:
      - id: a
        kind: agent
        agent: a
`);
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
