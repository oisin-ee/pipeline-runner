import { describe, expect, it } from "vitest";
import { parsePipelineConfigParts } from "../../config";
import {
  createRuntimeContext,
  normalizeMaxParallelNodes,
  resolveWorkflowSelection,
} from "./context";

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
    baseline: execute
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

  it("creates a runtime context with defaults and honors explicit run id", () => {
    const withoutRunId = createRuntimeContext({
      config: configWithWorkflow(),
      task: "task",
    });
    const withRunId = createRuntimeContext({
      config: configWithWorkflow(),
      runId: "run-explicit",
      task: "task",
    });

    expect(withoutRunId.runId).toBeUndefined();
    expect(withRunId.runId).toBe("run-explicit");
    expect(withRunId.hookPolicy).toEqual({
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: ["PATH"],
      outputLimitBytes: 65_536,
      timeoutMs: 30_000,
    });
    expect(withRunId.nodeStates.get("a")).toMatchObject({
      attempts: 0,
      evidence: [],
      gates: [],
      id: "a",
      status: "pending",
    });
  });
});
