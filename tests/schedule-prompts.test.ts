import { describe, expect, it } from "vitest";
import { parsePipelineConfigParts } from "../src/config";
import type {
  ScheduleArtifact,
  SchedulePlanningContext,
} from "../src/planning/generate";
import { plannerPrompt } from "../src/schedule/prompts";

const PIPELINE = `
version: 1
default_workflow: root
token_budget:
  default_context_window: 200000
  max_context_pct: 50
  model_context_windows:
    openai/gpt-5.5: 400000
  fan_out_width:
    default: 4
    by_category:
      green: 2
scheduler:
  node_catalogs:
    execute:
      required_categories: [green]
      nodes:
        green-impl:
          category: green
          profile: coder
          models: [openai/gpt-5.5]
workflows:
  root:
    nodes:
      - id: green-impl
        kind: agent
        profile: coder
`;

const PROFILES = `
version: 1
profiles:
  coder:
    runner: opencode
    instructions:
      inline: Write code.
`;

const RUNNERS = `
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
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
`;

const BASELINE = { workflows: {} } as unknown as ScheduleArtifact;
const PLANNING_CONTEXT = {
  parentWorkUnits: [],
  workUnits: [],
} as unknown as SchedulePlanningContext;

describe("plannerPrompt token budget", () => {
  it("emits the context cap, model windows, and fan-out caps", () => {
    const config = parsePipelineConfigParts({
      pipeline: PIPELINE,
      profiles: PROFILES,
      runners: RUNNERS,
    });
    const prompt = plannerPrompt(
      "execute",
      "do it",
      BASELINE,
      config,
      PLANNING_CONTEXT
    );
    expect(prompt).toContain("under 50% of its model's context window");
    expect(prompt).toContain("openai/gpt-5.5=400000");
    expect(prompt).toContain("Default width: 4");
    expect(prompt).toContain("green=2");
  });
});
