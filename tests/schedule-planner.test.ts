import { describe, expect, it } from "vitest";
import { parsePipelineConfigParts } from "../src/config.js";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../src/schedule-planner.js";

const EXTERNAL_WORKFLOW_RE = /external workflow/i;

const RUNNERS = `
version: 1
runners:
  codex:
    type: codex
    command: codex
    model: gpt-5
    capabilities:
      native_subagents: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json_schema]
`;

const PROFILES = `
version: 1
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: Orchestrate }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  pipeline-schedule-planner:
    runner: codex
    instructions: { inline: Plan schedules }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
    output:
      format: text
  pipeline-researcher:
    runner: codex
    instructions: { inline: Research }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  pipeline-code-writer:
    runner: codex
    instructions: { inline: Implement }
    tools: [read, edit, write, bash]
    filesystem: { mode: workspace-write }
    network: { mode: inherit }
  pipeline-verifier:
    runner: codex
    instructions: { inline: Verify }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
`;

const PIPELINE = `
version: 1
default_workflow: default
entrypoints:
  pipe:
    schedule: default-schedule
    description: Generated schedule
orchestrator:
  profile: orchestrator
schedules:
  default-schedule:
    baseline: pipe
    planner_profile: pipeline-schedule-planner
workflows:
  inspect:
    nodes:
      - id: inspect
        kind: agent
        profile: pipeline-researcher
  default:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
`;

function config() {
  return parsePipelineConfigParts({
    pipeline: PIPELINE,
    profiles: PROFILES,
    runners: RUNNERS,
  });
}

describe("schedule artifacts", () => {
  it("compiles embedded workflows into an isolated execution plan", () => {
    const artifact = parseScheduleArtifact(`
version: 1
kind: pipeline-schedule
schedule_id: run-a
source_entrypoint: pipe
task: Implement generated schedules
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: implement
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [implement]
`);

    const compiled = compileScheduleArtifact(config(), artifact);

    expect(compiled.workflowId).toBe("schedule-run-a-root");
    expect(compiled.plan.topologicalOrder.map((node) => node.id)).toEqual([
      "research",
      "implement",
      "verify",
    ]);
    expect(compiled.config.workflows["schedule-run-a-root"]).toBeDefined();
  });

  it("rejects workflow nodes that reference workflows outside the artifact", () => {
    const artifact = parseScheduleArtifact(`
version: 1
kind: pipeline-schedule
schedule_id: run-a
source_entrypoint: pipe
task: Implement generated schedules
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: external
        kind: workflow
        workflow: default
`);

    expect(() => compileScheduleArtifact(config(), artifact)).toThrow(
      EXTERNAL_WORKFLOW_RE
    );
  });
});
