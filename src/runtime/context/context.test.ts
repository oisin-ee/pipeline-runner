import { describe, expect, it } from "vitest";
import { parsePipelineConfigParts } from "../../config";
import {
  createRuntimeContext,
  normalizeMaxParallelNodes,
  resolveWorkflowSelection,
} from "./context";

const RUN_ID_PREFIX_RE = /^run-/;

function configWithWorkflow(extraWorkflow = "") {
  return parsePipelineConfigParts({
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
  a:
    runner: codex
    instructions: { inline: A }
`,
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: a
entrypoints:
  default-entry:
    workflow: default
  nightly:
    schedule: nightly-schedule
schedules:
  nightly-schedule:
    baseline: pipe
workflows:
${extraWorkflow}
  default:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
  });
}

describe("runtime context", () => {
  it("resolves workflow entrypoints and rejects schedule entrypoints", () => {
    const config = configWithWorkflow();

    expect(resolveWorkflowSelection(config, undefined, "default-entry")).toBe(
      "default"
    );
    expect(() =>
      resolveWorkflowSelection(config, undefined, "nightly")
    ).toThrow(
      "Pipeline entrypoint 'nightly' generates schedule 'nightly-schedule'; run with --schedule <schedule.yaml> instead."
    );
    expect(() =>
      resolveWorkflowSelection(config, undefined, "missing")
    ).toThrow("Unknown pipeline entrypoint 'missing'");
  });

  it("normalizes maxParallelNodes as a positive integer", () => {
    expect(normalizeMaxParallelNodes(2)).toBe(2);
    expect(() => normalizeMaxParallelNodes(0)).toThrow(
      "maxParallelNodes must be a positive integer"
    );
    expect(() => normalizeMaxParallelNodes(1.5)).toThrow(
      "maxParallelNodes must be a positive integer"
    );
  });

  it("creates a runtime context with defaults and generated run id only when referenced", () => {
    const withoutRunIdTemplate = createRuntimeContext({
      config: configWithWorkflow(),
      task: "task",
    });
    const withRunIdTemplate = createRuntimeContext({
      config: configWithWorkflow(`
  templated:
    nodes:
      - id: child
        kind: workflow
        workflow: default
        worktree_root: .pipeline/worktrees/$${"{runId}"}/$${"{nodeId}"}
`),
      task: "task",
      workflowId: "templated",
    });

    expect(withoutRunIdTemplate.runId).toBeUndefined();
    expect(withRunIdTemplate.runId).toMatch(RUN_ID_PREFIX_RE);
    expect(withRunIdTemplate.hookPolicy).toEqual({
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: ["PATH"],
      outputLimitBytes: 65_536,
      timeoutMs: 30_000,
    });
    expect(withRunIdTemplate.nodeStates.get("child")).toMatchObject({
      attempts: 0,
      evidence: [],
      gates: [],
      id: "child",
      status: "pending",
    });
  });
});
