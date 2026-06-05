import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePipelineConfigParts,
  type SchedulingRole,
} from "../src/config.js";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
} from "../src/schedule-planner.js";

const EXTERNAL_WORKFLOW_RE = /external workflow/i;
const MISSING_WORK_UNIT_RE = /missing assigned backlog work units.*PIPE-41\.8/s;
const DOWNSTREAM_COVERAGE_RE = /without downstream verification or review/i;
const WORK_UNIT_DEPENDENCY_RE =
  /work unit dependency edge.*PC-37\.2.*PC-37\.1/s;
const PLANNER_OUTPUT_RE = /Planner output:\s+version: 1/s;
const WORKFLOW_TASK_ASSIGNMENT_RE =
  /backlog work unit assignments must use explicit generated agent nodes/i;

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
  opencode:
    type: opencode
    command: opencode
    model: openai/gpt-5.4-mini
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
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
  pipeline-test-writer:
    runner: codex
    instructions: { inline: Test }
    tools: [read, edit, write, bash]
    filesystem: { mode: workspace-write }
    network: { mode: inherit }
  pipeline-code-writer:
    runner: codex
    scheduling_roles: [implementation]
    instructions: { inline: Implement }
    tools: [read, edit, write, bash]
    filesystem: { mode: workspace-write }
    network: { mode: inherit }
  pipeline-verifier:
    runner: codex
    scheduling_roles: [coverage]
    instructions: { inline: Verify }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  pipeline-acceptance-reviewer:
    runner: codex
    scheduling_roles: [coverage]
    instructions: { inline: Acceptance }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  pipeline-epic-router:
    runner: codex
    instructions: { inline: Route }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  pipeline-thermo-nuclear-reviewer:
    runner: codex
    scheduling_roles: [coverage]
    instructions: { inline: Review }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  pipeline-learner:
    runner: codex
    instructions: { inline: Learn }
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
  epic:
    schedule: epic-schedule
    description: Generated epic schedule
orchestrator:
  profile: orchestrator
schedules:
  default-schedule:
    baseline: pipe
    planner_profile: pipeline-schedule-planner
  epic-schedule:
    baseline: epic
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
      - id: red
        kind: agent
        profile: pipeline-test-writer
        needs: [research]
        gates:
          - id: red-test-file-policy
            kind: changed_files
            changed_files:
              allow: ["**/*.test.*", "tests/**"]
              require_any: ["**/*.test.*", "tests/**"]
      - id: green
        kind: agent
        profile: pipeline-code-writer
        needs: [red]
      - id: acceptance
        kind: agent
        profile: pipeline-acceptance-reviewer
        needs: [green]
        gates:
          - id: acceptance-coverage
            kind: acceptance
            target: stdout
            required: false
          - id: acceptance-verdict
            kind: verdict
            target: stdout
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [acceptance]
        gates:
          - id: verify-typecheck
            kind: builtin
            builtin: typecheck
          - id: verify-tests
            kind: builtin
            builtin: test
          - id: verify-verdict
            kind: verdict
            target: stdout
      - id: learn
        kind: agent
        profile: pipeline-learner
        needs: [verify]
  epic-drain:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: plan
        kind: agent
        profile: pipeline-epic-router
        needs: [research]
      - id: implement
        kind: parallel
        needs: [plan]
        nodes:
          - id: test
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/\${runId}/test
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [implement]
      - id: review
        kind: agent
        profile: pipeline-thermo-nuclear-reviewer
        needs: [merge]
        gates:
          - id: review-verdict
            kind: verdict
            target: stdout
  execute-slice:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: implement
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
      - id: acceptance
        kind: agent
        profile: pipeline-acceptance-reviewer
        needs: [implement]
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [acceptance]
`;

function config() {
  return parsePipelineConfigParts({
    pipeline: PIPELINE,
    profiles: PROFILES,
    runners: RUNNERS,
  });
}

function configWithSchedulingRoles(
  roleProfiles: Array<{
    baseProfileId: keyof ReturnType<typeof config>["profiles"];
    profileId: string;
    roles: SchedulingRole[];
  }>
): ReturnType<typeof config> {
  const parsed = config();
  for (const { baseProfileId, profileId, roles } of roleProfiles) {
    parsed.profiles[profileId] = {
      ...parsed.profiles[baseProfileId],
      instructions: {
        inline: `${profileId} test profile`,
      },
      scheduling_roles: roles,
    };
  }
  return parsed;
}

function writeBacklogTask(
  root: string,
  id: string,
  title: string,
  body: string,
  options: { dependencies?: string[]; parentTaskId?: string } = {}
): void {
  const path = join(root, "backlog", "tasks", `${id.toLowerCase()} - task.md`);
  const parentTaskId =
    options.parentTaskId ?? (id.includes(".") ? "PIPE-41" : "");
  const dependencies =
    options.dependencies && options.dependencies.length > 0
      ? `dependencies:\n${options.dependencies.map((dep) => `  - ${dep}`).join("\n")}\n`
      : "";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\nid: ${id}\ntitle: ${title}\nparent_task_id: ${parentTaskId}\n${dependencies}---\n\n${body}`,
    "utf8"
  );
}

describe("schedule artifacts", () => {
  it("accepts explicit scheduling roles in profile config", () => {
    const parsed = parsePipelineConfigParts({
      pipeline: PIPELINE,
      profiles: PROFILES,
      runners: RUNNERS,
    });

    expect(
      (
        parsed.profiles["pipeline-code-writer"] as unknown as {
          scheduling_roles: string[];
        }
      ).scheduling_roles
    ).toEqual(["implementation"]);
    expect(
      (
        parsed.profiles["pipeline-verifier"] as unknown as {
          scheduling_roles: string[];
        }
      ).scheduling_roles
    ).toEqual(["coverage"]);
  });

  it("does not infer scheduling roles from default profile ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-role-contract-"));
    const profilesWithoutRoles = PROFILES.replaceAll(
      "    scheduling_roles: [implementation]\n",
      ""
    ).replaceAll("    scheduling_roles: [coverage]\n", "");
    const roleConfig = parsePipelineConfigParts({
      pipeline: PIPELINE,
      profiles: profilesWithoutRoles,
      runners: RUNNERS,
    });
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-role-contract
source_entrypoint: pipe
task: Role contract
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: pipeline-code-writer
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: roleConfig,
          entrypointId: "pipe",
          executor: () => ({ exitCode: 0, stdout: schedule }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-role-contract",
          task: "Role contract",
          worktreePath: dir,
        })
      ).resolves.toMatchObject({
        artifact: {
          schedule_id: "run-role-contract",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows runner, model, grants, and output metadata for allowed planner profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-profile-fit-"));
    const richConfig = config();
    richConfig.profiles["pipeline-opencode-code-writer"] = {
      ...richConfig.profiles["pipeline-code-writer"],
      description: "Implement production code with OpenCode.",
      model: "openai/gpt-5.4-mini",
      runner: "opencode",
    };
    let prompt = "";
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-profile-fit
source_entrypoint: pipe
task: Profile fit
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: pipeline-opencode-code-writer
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [implement]
`;

    try {
      await generateScheduleArtifact({
        config: richConfig,
        entrypointId: "pipe",
        executor: (plan) => {
          prompt = plan.args.join("\n");
          return { exitCode: 0, stdout: schedule };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-profile-fit",
        task: "Profile fit",
        worktreePath: dir,
      });

      expect(prompt).toContain("- pipeline-opencode-code-writer");
      expect(prompt).toContain("runner: opencode");
      expect(prompt).toContain("model: openai/gpt-5.4-mini");
      expect(prompt).toContain("scheduling_roles: implementation");
      expect(prompt).toContain("filesystem: workspace-write");
      expect(prompt).toContain("tools: read, edit, write, bash");
      expect(prompt).toContain("output: text");
      expect(prompt).toContain("description: Implement production code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("parses a planner schedule from codex JSONL agent output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-jsonl-"));
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-jsonl
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
`;

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "pipe",
        executor: () => ({
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "turn.started" }),
            JSON.stringify({
              item: { text: schedule, type: "agent_message" },
              type: "item.completed",
            }),
            JSON.stringify({ type: "turn.completed" }),
          ].join("\n"),
        }),
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-jsonl",
        task: "Implement generated schedules",
        worktreePath: dir,
      });

      expect(result.artifact.schedule_id).toBe("run-jsonl");
      expect(existsSync(join(dir, ".pipeline"))).toBe(false);
      expect(
        result.artifact.workflows.root.nodes.map((node) => node.id)
      ).toEqual(["research", "implement", "verify"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonicalizes generated planner node ids before validating the schedule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-id-repair-"));
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-repair
source_entrypoint: pipe
task: Implement PIPE-44
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research_role_contract
        kind: agent
        profile: pipeline-researcher
      - id: green_scheduler_roles
        kind: agent
        profile: pipeline-code-writer
        needs: [research_role_contract]
      - id: verify_real_schedule_flows
        kind: agent
        profile: pipeline-verifier
        needs: [green_scheduler_roles]
`;

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "pipe",
        executor: () => ({ exitCode: 0, stdout: schedule }),
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-repair",
        task: "Implement PIPE-44",
        worktreePath: dir,
      });

      expect(
        result.artifact.workflows.root.nodes.map((node) => node.id)
      ).toEqual([
        "research-role-contract",
        "green-scheduler-roles",
        "verify-real-schedule-flows",
      ]);
      expect(result.artifact.workflows.root.nodes[1]).toMatchObject({
        needs: ["research-role-contract"],
      });
      expect(result.artifact.workflows.root.nodes[2]).toMatchObject({
        needs: ["green-scheduler-roles"],
      });
      expect(result.path).toBe("memory:run-repair");
      expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves malformed planner output for real failure diagnosis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-invalid-"));
    const malformed = `
version: 1
kind: pipeline-schedule
schedule_id: run-invalid
source_entrypoint: pipe
task: Bad: compact scalar
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "pipe",
          executor: () => ({ exitCode: 0, stdout: malformed }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-invalid",
          task: "Bad compact scalar",
          worktreePath: dir,
        })
      ).rejects.toThrow(PLANNER_OUTPUT_RE);

      expect(existsSync(join(dir, ".pipeline"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives agent_graph planners backlog work units and allowed primitives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-agent-graph-"));
    writeBacklogTask(
      dir,
      "PIPE-41",
      "Agent-driven workflow scheduling",
      "## Description\n\nParent epic."
    );
    writeBacklogTask(
      dir,
      "PIPE-41.7",
      "Propagate node context",
      "## Description\n\nCarry context.\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Prompts include task context.\n<!-- AC:END -->"
    );
    writeBacklogTask(
      dir,
      "PIPE-41.8",
      "Resolve backlog children",
      "## Description\n\nLoad child tickets.\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Work units come from Backlog.\n<!-- AC:END -->"
    );
    const seenPrompts: string[] = [];
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-epic
source_entrypoint: epic
task: PIPE-41
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: scheduler-context-red
        kind: agent
        profile: pipeline-test-writer
        needs: [research]
      - id: pipe-41-7-green
        kind: agent
        profile: pipeline-code-writer
        needs: [scheduler-context-red]
        task_context:
          id: PIPE-41.7
      - id: pipe-41-8-green
        kind: agent
        profile: pipeline-code-writer
        needs: [scheduler-context-red]
        task_context:
          id: PIPE-41.8
      - id: scheduler-context-acceptance
        kind: agent
        profile: pipeline-acceptance-reviewer
        needs: [pipe-41-7-green, pipe-41-8-green]
      - id: scheduler-context-verify
        kind: agent
        profile: pipeline-verifier
        needs: [scheduler-context-acceptance]
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [scheduler-context-verify]
      - id: review
        kind: agent
        profile: pipeline-thermo-nuclear-reviewer
        needs: [merge]
`;

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "epic",
        executor: (plan) => {
          seenPrompts.push(plan.args.join("\n"));
          return { exitCode: 0, stdout: schedule };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-epic",
        task: "PIPE-41",
        worktreePath: dir,
      });

      expect(seenPrompts[0]).toContain("Planner mode: constrained agent graph");
      expect(seenPrompts[0]).toContain("Backlog work units:");
      expect(seenPrompts[0]).toContain("Backlog parent context:");
      expect(seenPrompts[0]).toContain("Agent-driven workflow scheduling");
      expect(seenPrompts[0]).toContain("PIPE-41.7");
      expect(seenPrompts[0]).toContain("PIPE-41.8");
      expect(seenPrompts[0]).toContain("Allowed profiles:");
      expect(seenPrompts[0]).toContain("pipeline-code-writer");
      expect(seenPrompts[0]).not.toContain("Allowed workflows:");
      expect(seenPrompts[0]).toContain("Do not use kind: workflow");
      expect(seenPrompts[0]).toContain("root_workflow: root");
      expect(seenPrompts[0]).toContain("Shape the graph by intent");
      expect(seenPrompts[0]).toContain(
        "Do not create a full RED/GREEN/ACCEPTANCE/VERIFY chain for each backlog ticket"
      );
      expect(seenPrompts[0]).toContain("red-test-file-policy");
      expect(seenPrompts[0]).toContain("changed_files:");
      expect(seenPrompts[0]).toContain("require_any:");
      expect(Object.keys(result.artifact.workflows)).toEqual(["root"]);
      expect(result.artifact.workflows.root.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "scheduler-context-red",
            kind: "agent",
            profile: "pipeline-test-writer",
          }),
          expect.objectContaining({
            id: "pipe-41-7-green",
            kind: "agent",
            profile: "pipeline-code-writer",
            task_context: expect.objectContaining({
              acceptance_criteria: [
                { id: "1", text: "Prompts include task context." },
              ],
              description: "Carry context.",
              id: "PIPE-41.7",
              title: "Propagate node context",
            }),
          }),
          expect.objectContaining({
            id: "pipe-41-8-green",
            kind: "agent",
            profile: "pipeline-code-writer",
            task_context: expect.objectContaining({
              acceptance_criteria: [
                { id: "1", text: "Work units come from Backlog." },
              ],
              description: "Load child tickets.",
              id: "PIPE-41.8",
              title: "Resolve backlog children",
            }),
          }),
          expect.objectContaining({
            id: "merge",
            kind: "builtin",
            needs: ["scheduler-context-verify"],
          }),
          expect.objectContaining({
            id: "scheduler-context-acceptance",
            kind: "agent",
            needs: ["pipe-41-7-green", "pipe-41-8-green"],
            profile: "pipeline-acceptance-reviewer",
          }),
          expect.objectContaining({
            id: "scheduler-context-verify",
            kind: "agent",
            needs: ["scheduler-context-acceptance"],
            profile: "pipeline-verifier",
          }),
        ])
      );
      expect(() =>
        compileScheduleArtifact(config(), result.artifact, dir)
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes Backlog child dependency metadata to the schedule planner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-pc37-"));
    writeBacklogTask(
      dir,
      "PC-37",
      "Pipeline console rollout",
      "## Description\n\nParent epic.",
      { parentTaskId: "" }
    );
    writeBacklogTask(
      dir,
      "PC-37.1",
      "Define runner contract",
      "## Description\n\nDefine contract.\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Contract is stable.\n<!-- AC:END -->",
      { parentTaskId: "PC-37" }
    );
    writeBacklogTask(
      dir,
      "PC-37.2",
      "Build API endpoint",
      "## Description\n\nBuild endpoint.",
      { dependencies: ["PC-37.1"], parentTaskId: "PC-37" }
    );
    writeBacklogTask(
      dir,
      "PC-37.3",
      "Build frontend view",
      "## Description\n\nBuild frontend.",
      { dependencies: ["PC-37.1"], parentTaskId: "PC-37" }
    );
    writeBacklogTask(
      dir,
      "PC-37.4",
      "Add rollout verification",
      "## Description\n\nVerify rollout.",
      { dependencies: ["PC-37.2", "PC-37.3"], parentTaskId: "PC-37" }
    );
    const seenPrompts: string[] = [];
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-pc37
source_entrypoint: epic
task: PC-37
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: pc-37-1-green
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
        task_context:
          id: PC-37.1
      - id: pc-37-2-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pc-37-1-green]
        task_context:
          id: PC-37.2
      - id: pc-37-3-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pc-37-1-green]
        task_context:
          id: PC-37.3
      - id: pc-37-4-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pc-37-2-green, pc-37-3-green]
        task_context:
          id: PC-37.4
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [pc-37-4-green]
`;

    try {
      await generateScheduleArtifact({
        config: config(),
        entrypointId: "epic",
        executor: (plan) => {
          seenPrompts.push(plan.args.join("\n"));
          return { exitCode: 0, stdout: schedule };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-pc37",
        task: "PC-37",
        worktreePath: dir,
      });

      const prompt = seenPrompts[0] ?? "";
      expect(prompt).toContain(
        "Preserve Backlog dependency ids as schedule needs edges"
      );
      expect(prompt).toContain("id: PC-37.2");
      expect(prompt).toContain("dependencies:");
      expect(prompt).toContain("- PC-37.1");
      expect(prompt).toContain("id: PC-37.4");
      expect(prompt).toContain("- PC-37.2");
      expect(prompt).toContain("- PC-37.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects generated schedules that ignore Backlog child dependency edges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-pc37-invalid-"));
    writeBacklogTask(
      dir,
      "PC-37",
      "Pipeline console rollout",
      "## Description\n\nParent epic.",
      { parentTaskId: "" }
    );
    writeBacklogTask(
      dir,
      "PC-37.1",
      "Define runner contract",
      "## Description\n\nDefine contract.",
      { parentTaskId: "PC-37" }
    );
    writeBacklogTask(
      dir,
      "PC-37.2",
      "Build API endpoint",
      "## Description\n\nBuild endpoint.",
      { dependencies: ["PC-37.1"], parentTaskId: "PC-37" }
    );
    writeBacklogTask(
      dir,
      "PC-37.3",
      "Build frontend view",
      "## Description\n\nBuild frontend.",
      { parentTaskId: "PC-37" }
    );
    const invalidSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-pc37-invalid
source_entrypoint: epic
task: PC-37
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: pc-37-1-green
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
        task_context:
          id: PC-37.1
      - id: pc-37-2-green
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
        task_context:
          id: PC-37.2
      - id: pc-37-3-green
        kind: agent
        profile: pipeline-code-writer
        needs: [research]
        task_context:
          id: PC-37.3
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [pc-37-1-green, pc-37-2-green, pc-37-3-green]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "epic",
          executor: () => ({ exitCode: 0, stdout: invalidSchedule }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-pc37-invalid",
          task: "PC-37",
          worktreePath: dir,
        })
      ).rejects.toThrow(WORK_UNIT_DEPENDENCY_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects backlog assignments hidden behind workflow-reference nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-workflow-ref-"));
    writeBacklogTask(
      dir,
      "PIPE-41",
      "Agent-driven workflow scheduling",
      "## Description\n\nParent epic."
    );
    writeBacklogTask(
      dir,
      "PIPE-41.7",
      "Propagate node context",
      "## Description\n\nCarry context."
    );
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-epic
source_entrypoint: epic
task: PIPE-41
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: pipe-41-7
        kind: workflow
        workflow: default
        task_context:
          id: PIPE-41.7
  default:
    nodes:
      - id: implement
        kind: agent
        profile: pipeline-code-writer
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [implement]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "epic",
          executor: () => ({ exitCode: 0, stdout: schedule }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-epic",
          task: "PIPE-41",
          worktreePath: dir,
        })
      ).rejects.toThrow(WORKFLOW_TASK_ASSIGNMENT_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses an exact child ticket as the only work unit for single-ticket schedules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-single-ticket-"));
    writeBacklogTask(
      dir,
      "PIPE-41",
      "Agent-driven workflow scheduling",
      "## Description\n\nParent epic."
    );
    writeBacklogTask(
      dir,
      "PIPE-41.7",
      "Propagate node context",
      "## Description\n\nCarry context.\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Prompts include task context.\n<!-- AC:END -->"
    );
    writeBacklogTask(
      dir,
      "PIPE-41.8",
      "Resolve backlog children",
      "## Description\n\nLoad child tickets."
    );
    const seenPrompts: string[] = [];
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-single
source_entrypoint: pipe
task: PIPE-41.7
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: pipe-41-7-red
        kind: agent
        profile: pipeline-test-writer
        needs: [research]
        task_context:
          id: PIPE-41.7
      - id: pipe-41-7-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pipe-41-7-red]
        task_context:
          id: PIPE-41.7
      - id: pipe-41-7-verify
        kind: agent
        profile: pipeline-verifier
        needs: [pipe-41-7-green]
        task_context:
          id: PIPE-41.7
`;

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "pipe",
        executor: (plan) => {
          seenPrompts.push(plan.args.join("\n"));
          return { exitCode: 0, stdout: schedule };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-single",
        task: "PIPE-41.7",
        worktreePath: dir,
      });

      const prompt = seenPrompts[0] ?? "";
      expect(prompt).toContain("id: PIPE-41.7");
      expect(prompt).not.toContain("id: PIPE-41.8");
      expect(result.artifact.workflows.root.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "pipe-41-7-green",
            profile: "pipeline-code-writer",
            task_context: expect.objectContaining({
              id: "PIPE-41.7",
              title: "Propagate node context",
            }),
          }),
        ])
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads every referenced epic and descendant work unit for one generated graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-multi-epic-"));
    writeBacklogTask(
      dir,
      "PIPE-50",
      "First epic",
      "## Description\n\nFirst parent.",
      { parentTaskId: "" }
    );
    writeBacklogTask(
      dir,
      "PIPE-50.1",
      "First root child",
      "## Description\n\nFirst child.",
      { parentTaskId: "PIPE-50" }
    );
    writeBacklogTask(
      dir,
      "PIPE-50.1.1",
      "Nested first child",
      "## Description\n\nNested first child.",
      { parentTaskId: "PIPE-50.1" }
    );
    writeBacklogTask(
      dir,
      "PIPE-51",
      "Second epic",
      "## Description\n\nSecond parent.",
      { parentTaskId: "" }
    );
    writeBacklogTask(
      dir,
      "PIPE-51.1",
      "Second root child",
      "## Description\n\nSecond child.",
      { parentTaskId: "PIPE-51" }
    );
    const seenPrompts: string[] = [];
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-multi-epic
source_entrypoint: epic
task: Execute PIPE-50 and PIPE-51
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: pipe-50-1-green
        kind: agent
        profile: pipeline-code-writer
        task_context:
          id: PIPE-50.1
      - id: pipe-50-1-1-green
        kind: agent
        profile: pipeline-code-writer
        needs: [pipe-50-1-green]
        task_context:
          id: PIPE-50.1.1
      - id: pipe-51-1-green
        kind: agent
        profile: pipeline-code-writer
        task_context:
          id: PIPE-51.1
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [pipe-50-1-1-green, pipe-51-1-green]
`;

    try {
      await generateScheduleArtifact({
        config: config(),
        entrypointId: "epic",
        executor: (plan) => {
          seenPrompts.push(plan.args.join("\n"));
          return { exitCode: 0, stdout: schedule };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-multi-epic",
        task: "Execute PIPE-50 and PIPE-51",
        worktreePath: dir,
      });

      const prompt = seenPrompts[0] ?? "";
      expect(prompt).toContain("id: PIPE-50.1");
      expect(prompt).toContain("id: PIPE-50.1.1");
      expect(prompt).toContain("id: PIPE-51.1");
      expect(prompt).toContain(
        "Only add needs edges for real dependencies, shared constraints, or verification/review fan-in."
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects agent_graph schedules that skip backlog work units", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-agent-graph-"));
    writeBacklogTask(
      dir,
      "PIPE-41",
      "Agent-driven workflow scheduling",
      "## Description\n\nParent epic."
    );
    writeBacklogTask(
      dir,
      "PIPE-41.7",
      "Propagate node context",
      "## Description\n\nCarry context."
    );
    writeBacklogTask(
      dir,
      "PIPE-41.8",
      "Resolve backlog children",
      "## Description\n\nLoad child tickets."
    );
    const shortcut = `
version: 1
kind: pipeline-schedule
schedule_id: run-epic
source_entrypoint: epic
task: PIPE-41
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: pipeline-code-writer
        task_context:
          id: PIPE-41.7
          title: Propagate node context
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [implement]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "epic",
          executor: () => ({ exitCode: 0, stdout: shortcut }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-epic",
          task: "PIPE-41",
          worktreePath: dir,
        })
      ).rejects.toThrow(MISSING_WORK_UNIT_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects agent_graph implementation nodes without downstream verification or review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-agent-graph-"));
    const shortcut = `
version: 1
kind: pipeline-schedule
schedule_id: run-epic
source_entrypoint: epic
task: Ad hoc epic
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: pipeline-code-writer
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "epic",
          executor: () => ({ exitCode: 0, stdout: shortcut }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-epic",
          task: "Ad hoc epic",
          worktreePath: dir,
        })
      ).rejects.toThrow(DOWNSTREAM_COVERAGE_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects custom implementation-role nodes without downstream verification or review", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-custom-implementation-")
    );
    const roleConfig = configWithSchedulingRoles([
      {
        baseProfileId: "pipeline-code-writer",
        profileId: "custom-implementer",
        roles: ["implementation"],
      },
    ]);
    const shortcut = `
version: 1
kind: pipeline-schedule
schedule_id: run-custom-implementation
source_entrypoint: epic
task: Ad hoc epic
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: custom-implementer
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: roleConfig,
          entrypointId: "epic",
          executor: () => ({ exitCode: 0, stdout: shortcut }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-custom-implementation",
          task: "Ad hoc epic",
          worktreePath: dir,
        })
      ).rejects.toThrow(DOWNSTREAM_COVERAGE_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts default implementation nodes covered by a custom coverage-role profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-custom-cover-"));
    const roleConfig = configWithSchedulingRoles([
      {
        baseProfileId: "pipeline-code-writer",
        profileId: "pipeline-code-writer",
        roles: ["implementation"],
      },
      {
        baseProfileId: "pipeline-verifier",
        profileId: "custom-verifier",
        roles: ["coverage"],
      },
    ]);
    const covered = `
version: 1
kind: pipeline-schedule
schedule_id: run-custom-cover
source_entrypoint: pipe
task: Covered implementation
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: pipeline-code-writer
      - id: verify
        kind: agent
        profile: custom-verifier
        needs: [implement]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: roleConfig,
          entrypointId: "pipe",
          executor: () => ({ exitCode: 0, stdout: covered }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-custom-cover",
          task: "Covered implementation",
          worktreePath: dir,
        })
      ).resolves.toMatchObject({
        artifact: {
          schedule_id: "run-custom-cover",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces Backlog dependency edges for custom implementation-role profiles", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-custom-dependency-")
    );
    writeBacklogTask(
      dir,
      "PC-37",
      "Pipeline console rollout",
      "## Description\n\nParent epic.",
      { parentTaskId: "" }
    );
    writeBacklogTask(
      dir,
      "PC-37.1",
      "Define runner contract",
      "## Description\n\nDefine contract.",
      { parentTaskId: "PC-37" }
    );
    writeBacklogTask(
      dir,
      "PC-37.2",
      "Build API endpoint",
      "## Description\n\nBuild endpoint.",
      { dependencies: ["PC-37.1"], parentTaskId: "PC-37" }
    );
    const roleConfig = configWithSchedulingRoles([
      {
        baseProfileId: "pipeline-code-writer",
        profileId: "custom-implementer",
        roles: ["implementation"],
      },
      {
        baseProfileId: "pipeline-verifier",
        profileId: "custom-verifier",
        roles: ["coverage"],
      },
    ]);
    const invalidSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-custom-dependency
source_entrypoint: epic
task: PC-37
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: pc-37-1-green
        kind: agent
        profile: custom-implementer
        needs: [research]
        task_context:
          id: PC-37.1
      - id: pc-37-2-green
        kind: agent
        profile: custom-implementer
        needs: [research]
        task_context:
          id: PC-37.2
      - id: verify
        kind: agent
        profile: custom-verifier
        needs: [pc-37-1-green, pc-37-2-green]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: roleConfig,
          entrypointId: "epic",
          executor: () => ({ exitCode: 0, stdout: invalidSchedule }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-custom-dependency",
          task: "PC-37",
          worktreePath: dir,
        })
      ).rejects.toThrow(WORK_UNIT_DEPENDENCY_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts implementation nodes with multi-hop downstream verification coverage", () => {
    const artifact = parseScheduleArtifact(`
version: 1
kind: pipeline-schedule
schedule_id: run-covered
source_entrypoint: pipe
task: Covered implementation
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement-a
        kind: agent
        profile: pipeline-code-writer
      - id: implement-b
        kind: agent
        profile: pipeline-code-writer
      - id: aggregate
        kind: command
        command: [echo, aggregate]
        needs: [implement-a, implement-b]
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [aggregate]
`);

    const compiled = compileScheduleArtifact(config(), artifact);

    expect(compiled.plan.topologicalOrder.map((node) => node.id)).toEqual([
      "implement-a",
      "implement-b",
      "aggregate",
      "verify",
    ]);
  });
});
