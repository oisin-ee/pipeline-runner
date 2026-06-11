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
import { parsePipelineConfigParts, type SchedulingRole } from "../src/config";
import {
  compileScheduleArtifact,
  generateScheduleArtifact,
  parseScheduleArtifact,
  type ScheduleArtifact,
} from "../src/schedule-planner";

const MISSING_WORK_UNIT_RE = /missing assigned backlog work units.*PIPE-41\.8/s;
const DOWNSTREAM_COVERAGE_RE = /without downstream verification or review/i;
const WORK_UNIT_DEPENDENCY_RE =
  /work unit dependency edge.*PC-37\.2.*PC-37\.1/s;
const SHARED_WORKTREE_PARALLEL_RE =
  /write-capable children sharing a worktree/i;
const PLANNER_OUTPUT_RE = /Planner output:\s+version: 1/s;
const PLANNER_FAILURE_WITH_DETAILS_RE =
  /schedule planner 'moka-schedule-planner' failed with exit 1.*planner auth missing.*partial planner output/s;
const PLANNER_TIMEOUT_FAILURE_RE =
  /schedule planner 'moka-schedule-planner' failed with exit 1.*timed out waiting for scheduler subprocess/s;
const REPAIR_NODE_SCHEMA_RE =
  /Agent nodes must not contain instructions.*Command nodes must use command as a YAML sequence/s;
const GREEN_AFTER_RED_RE =
  /id: green-implementation[\s\S]*needs:\s+- red-tests/;

const RUNNERS = `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    model: gpt-5
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
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  moka-schedule-planner:
    runner: opencode
    instructions: { inline: Plan schedules }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
    output:
      format: text
  moka-researcher:
    runner: opencode
    instructions: { inline: Research }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  moka-test-writer:
    runner: opencode
    instructions: { inline: Test }
    tools: [read, edit, write, bash]
    filesystem: { mode: workspace-write }
    network: { mode: inherit }
  moka-code-writer:
    runner: opencode
    scheduling_roles: [implementation]
    instructions: { inline: Implement }
    tools: [read, edit, write, bash]
    filesystem: { mode: workspace-write }
    network: { mode: inherit }
  moka-verifier:
    runner: opencode
    scheduling_roles: [coverage]
    instructions: { inline: Verify }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  moka-acceptance-reviewer:
    runner: opencode
    scheduling_roles: [coverage]
    instructions: { inline: Acceptance }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  moka-thermo-nuclear-reviewer:
    runner: opencode
    scheduling_roles: [coverage]
    instructions: { inline: Review }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  moka-learner:
    runner: opencode
    instructions: { inline: Learn }
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
`;

const PIPELINE = `
version: 1
default_workflow: inspect
entrypoints:
  execute:
    schedule: execute-schedule
    description: Generated schedule
  quick:
    schedule: quick-schedule
    description: Compact generated schedule
  inspect:
    workflow: inspect
orchestrator:
  profile: orchestrator
schedules:
  execute-schedule:
    baseline: execute
    planner_profile: moka-schedule-planner
  quick-schedule:
    baseline: quick
    planner_profile: moka-schedule-planner
workflows:
  inspect:
    nodes:
      - id: inspect
        kind: agent
        profile: moka-researcher
  execute-slice:
    nodes:
      - id: research
        kind: agent
        profile: moka-researcher
      - id: implement
        kind: agent
        profile: moka-code-writer
        needs: [research]
      - id: acceptance
        kind: agent
        profile: moka-acceptance-reviewer
        needs: [implement]
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [acceptance]
`;

function config() {
  return parsePipelineConfigParts({
    pipeline: PIPELINE,
    profiles: PROFILES,
    runners: RUNNERS,
  });
}

function compileScheduleArtifactOrThrow(
  artifact: ScheduleArtifact,
  worktreePath: string
): void {
  compileScheduleArtifact(config(), artifact, worktreePath);
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

function removeCoverageSchedulingRoles(
  parsed: ReturnType<typeof config>
): ReturnType<typeof config> {
  for (const profile of Object.values(parsed.profiles)) {
    const roles = profile.scheduling_roles?.filter(
      (role) => role !== "coverage"
    );
    if (roles?.length) {
      profile.scheduling_roles = roles;
    } else {
      profile.scheduling_roles = [];
    }
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

function buildScheduleYaml(options: {
  generatedAt?: string;
  nodes: string[];
  scheduleId: string;
  task: string;
}): string {
  const generatedAt = options.generatedAt ?? "2026-06-03T12:00:00.000Z";
  return [
    "version: 1",
    "kind: pipeline-schedule",
    `schedule_id: ${options.scheduleId}`,
    "source_entrypoint: execute",
    `task: ${options.task}`,
    `generated_at: ${generatedAt}`,
    "root_workflow: root",
    "workflows:",
    "  root:",
    "    nodes:",
    ...options.nodes.map((line) => `      ${line}`),
    "",
  ].join("\n");
}

async function generateScheduleWithPrompt(options: {
  entrypointId?: string;
  runId: string;
  schedule: string;
  task: string;
  worktreePath: string;
}): Promise<{
  prompt: string;
  result: Awaited<ReturnType<typeof generateScheduleArtifact>>;
}> {
  const seenPrompts: string[] = [];
  const result = await generateScheduleArtifact({
    config: config(),
    entrypointId: options.entrypointId ?? "execute",
    executor: (plan) => {
      seenPrompts.push(plan.args.join("\n"));
      return { exitCode: 0, stdout: options.schedule };
    },
    generatedAt: new Date("2026-06-03T12:00:00.000Z"),
    runId: options.runId,
    task: options.task,
    worktreePath: options.worktreePath,
  });
  return { prompt: seenPrompts[0] ?? "", result };
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
        parsed.profiles["moka-code-writer"] as unknown as {
          scheduling_roles: string[];
        }
      ).scheduling_roles
    ).toEqual(["implementation"]);
    expect(
      (
        parsed.profiles["moka-verifier"] as unknown as {
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
source_entrypoint: execute
task: Role contract
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: moka-code-writer
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: roleConfig,
          entrypointId: "execute",
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

  it("rejects write-capable parallel specialists without isolated worktrees or drain merge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-unsafe-team-"));
    const unsafeSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-unsafe-team
source_entrypoint: execute
task: Unsafe team
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: specialists
        kind: parallel
        nodes:
          - id: frontend
            kind: agent
            profile: moka-code-writer
          - id: backend
            kind: agent
            profile: moka-code-writer
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [specialists]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "execute",
          executor: () => ({ exitCode: 0, stdout: unsafeSchedule }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-unsafe-team",
          task: "Unsafe team",
          worktreePath: dir,
        })
      ).rejects.toThrow(SHARED_WORKTREE_PARALLEL_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes planner stderr when the planner exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moka-schedule-planner-fail-"));

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "execute",
          executor: () => ({
            exitCode: 1,
            stderr: "planner auth missing",
            stdout: "partial planner output",
          }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-planner-fail",
          task: "Expose planner failure",
          worktreePath: dir,
        })
      ).rejects.toThrow(PLANNER_FAILURE_WITH_DETAILS_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes timeout details when the planner subprocess times out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moka-schedule-planner-timeout-"));

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "execute",
          executor: () => ({
            exitCode: 1,
            stderr: "",
            stdout: "",
            timedOut: true,
          }),
          generatedAt: new Date("2026-06-03T12:00:00.000Z"),
          runId: "run-planner-timeout",
          task: "Expose planner timeout",
          worktreePath: dir,
        })
      ).rejects.toThrow(PLANNER_TIMEOUT_FAILURE_RE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps RED test-writing directly upstream of GREEN in the execute baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-red-green-"));
    let prompt = "";
    const schedule = buildScheduleYaml({
      scheduleId: "run-red-green",
      task: "Red green contract",
      nodes: [
        "- id: red-tests",
        "  kind: agent",
        "  profile: moka-test-writer",
        "- id: green-implementation",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [red-tests]",
        "- id: acceptance-review",
        "  kind: agent",
        "  profile: moka-acceptance-reviewer",
        "  needs: [green-implementation]",
        "- id: verification",
        "  kind: agent",
        "  profile: moka-verifier",
        "  needs: [acceptance-review]",
        "- id: learn",
        "  kind: agent",
        "  profile: moka-learner",
        "  needs: [verification]",
      ],
    });

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "execute",
        executor: (plan) => {
          prompt = plan.args.join("\n");
          return { exitCode: 0, stdout: schedule };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-red-green",
        task: "Red green contract",
        worktreePath: dir,
      });

      expect(prompt).toContain("green-implementation");
      expect(prompt).toMatch(GREEN_AFTER_RED_RE);
      expect(prompt).not.toContain("mechanical-red-tests");
      expect(prompt).not.toContain("mechanical-red-typecheck");
      expect(prompt).not.toContain("mechanical-red-lint");
      expect(prompt).not.toContain("mechanical-red-fallow");
      expect(result.artifact.workflows.root.nodes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "mechanical-red-tests" }),
          expect.objectContaining({ id: "mechanical-red-typecheck" }),
          expect.objectContaining({ id: "mechanical-red-lint" }),
          expect.objectContaining({ id: "mechanical-red-fallow" }),
        ])
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows runner, model, grants, and output metadata for allowed planner profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-profile-fit-"));
    const richConfig = config();
    richConfig.profiles["moka-opencode-code-writer"] = {
      ...richConfig.profiles["moka-code-writer"],
      description: "Implement production code with OpenCode.",
      model: "openai/gpt-5.4-mini",
      runner: "opencode",
    };
    let prompt = "";
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-profile-fit
source_entrypoint: execute
task: Profile fit
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: moka-opencode-code-writer
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [implement]
`;

    try {
      await generateScheduleArtifact({
        config: richConfig,
        entrypointId: "execute",
        executor: (plan) => {
          prompt = plan.args.join("\n");
          return { exitCode: 0, stdout: schedule };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-profile-fit",
        task: "Profile fit",
        worktreePath: dir,
      });

      expect(prompt).toContain("- moka-opencode-code-writer");
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
source_entrypoint: execute
task: Implement generated schedules
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: moka-researcher
      - id: implement
        kind: agent
        profile: moka-code-writer
        needs: [research]
      - id: verify
        kind: agent
        profile: moka-verifier
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

  it("canonicalizes generated planner node ids before validating the schedule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-id-repair-"));
    const schedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-repair
source_entrypoint: execute
task: Implement PIPE-44
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research_role_contract
        kind: agent
        profile: moka-researcher
      - id: green_scheduler_roles
        kind: agent
        profile: moka-code-writer
        needs: [research_role_contract]
      - id: verify_real_schedule_flows
        kind: agent
        profile: moka-verifier
        needs: [green_scheduler_roles]
`;

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "execute",
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
      expect(result.path).toBe(".pipeline/runs/run-repair/schedule.yaml");
      expect(existsSync(join(dir, result.path))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs OpenCode-style scalar command and node instructions before execution", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-opencode-repair-")
    );
    const opencodeConfig = config();
    opencodeConfig.profiles["moka-schedule-planner"] = {
      ...opencodeConfig.profiles["moka-schedule-planner"],
      runner: "opencode",
    };
    const invalidSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-opencode-repair
source_entrypoint: execute
task: Repair OpenCode schedule
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: inspect-devspace
        kind: command
        command: backlog task dev-k8s-01 --plain
      - id: implement
        kind: agent
        profile: moka-code-writer
        needs: [inspect-devspace]
        instructions: Implement the ticket without changing pipeline-console.
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [implement]
`;
    const repairedSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-opencode-repair
source_entrypoint: execute
task: Repair OpenCode schedule
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: inspect-devspace
        kind: command
        command: [backlog, task, dev-k8s-01, --plain]
      - id: implement
        kind: agent
        profile: moka-code-writer
        needs: [inspect-devspace]
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [implement]
`;
    const prompts: string[] = [];
    const nodeIds: string[] = [];

    try {
      const result = await generateScheduleArtifact({
        config: opencodeConfig,
        entrypointId: "execute",
        executor: (plan) => {
          prompts.push(plan.args.join("\n"));
          nodeIds.push(plan.nodeId);
          return {
            exitCode: 0,
            stdout:
              plan.nodeId === "schedule-plan-repair"
                ? repairedSchedule
                : invalidSchedule,
          };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-opencode-repair",
        task: "Repair OpenCode schedule",
        worktreePath: dir,
      });

      expect(nodeIds).toEqual(["schedule-plan", "schedule-plan-repair"]);
      expect(prompts[0]).toContain(
        "command must be a YAML sequence of strings"
      );
      expect(prompts[0]).toContain("Do not emit instructions");
      expect(prompts[1]).toMatch(REPAIR_NODE_SCHEMA_RE);
      expect(prompts[1]).toContain(
        "workflows.root.nodes.0.command: Invalid input: expected array, received string"
      );
      expect(prompts[1]).toContain('Unrecognized key: "instructions"');
      expect(result.artifact.workflows.root.nodes[0]).toMatchObject({
        command: ["backlog", "task", "dev-k8s-01", "--plain"],
        id: "inspect-devspace",
        kind: "command",
      });
      expect(result.artifact.workflows.root.nodes[1]).toEqual({
        id: "implement",
        kind: "agent",
        needs: ["inspect-devspace"],
        profile: "moka-code-writer",
      });
      expect(() =>
        compileScheduleArtifact(opencodeConfig, result.artifact, dir)
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs generated schedules that invent unsupported builtin ids", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-builtin-repair-")
    );
    const invalidSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-builtin-repair
source_entrypoint: execute
task: Run PIPE-2
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: pipe-1
        kind: builtin
        builtin: dependency
`;
    const repairedSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-builtin-repair
source_entrypoint: execute
task: Run PIPE-2
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: pipe-1
        kind: builtin
        builtin: typecheck
`;
    const prompts: string[] = [];
    const nodeIds: string[] = [];

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "execute",
        executor: (plan) => {
          prompts.push(plan.args.join("\n"));
          nodeIds.push(plan.nodeId);
          return {
            exitCode: 0,
            stdout:
              plan.nodeId === "schedule-plan-repair"
                ? repairedSchedule
                : invalidSchedule,
          };
        },
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-builtin-repair",
        task: "Run PIPE-2",
        worktreePath: dir,
      });

      expect(nodeIds).toEqual(["schedule-plan", "schedule-plan-repair"]);
      expect(prompts[0]).toContain(
        "Allowed builtin values: drain-merge, duplication, fallow, lint, semgrep, test, typecheck"
      );
      expect(prompts[1]).toContain("unsupported generated builtin");
      expect(result.artifact.workflows.root.nodes).toContainEqual({
        builtin: "typecheck",
        id: "pipe-1",
        kind: "builtin",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds generated coverage fan-in for uncovered implementation nodes", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-coverage-fan-in-")
    );
    const uncoveredSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-coverage-fan-in
source_entrypoint: execute
task: Cover generated implementation
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: green-state
        kind: agent
        profile: moka-code-writer
      - id: green-header-picker
        kind: agent
        profile: moka-code-writer
`;

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "execute",
        executor: () => ({ exitCode: 0, stdout: uncoveredSchedule }),
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-coverage-fan-in",
        task: "Cover generated implementation",
        worktreePath: dir,
      });

      expect(result.artifact.workflows.root.nodes.at(-1)).toMatchObject({
        id: "generated-coverage",
        kind: "agent",
        needs: ["green-state", "green-header-picker"],
        profile: "moka-verifier",
      });
      compileScheduleArtifactOrThrow(result.artifact, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds generated coverage inside parallel node scopes", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-parallel-coverage-fan-in-")
    );
    const uncoveredSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-parallel-coverage-fan-in
source_entrypoint: execute
task: Cover parallel implementation
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: current-club
        kind: parallel
        nodes:
          - id: implement-current-club-state
            kind: agent
            profile: moka-code-writer
          - id: implement-club-picker-header
            kind: agent
            profile: moka-code-writer
          - id: implement-signout-reset
            kind: agent
            profile: moka-code-writer
      - id: integration
        kind: builtin
        builtin: drain-merge
        needs: [current-club]
`;

    try {
      const result = await generateScheduleArtifact({
        config: config(),
        entrypointId: "execute",
        executor: () => ({ exitCode: 0, stdout: uncoveredSchedule }),
        generatedAt: new Date("2026-06-03T12:00:00.000Z"),
        runId: "run-parallel-coverage-fan-in",
        task: "Cover parallel implementation",
        worktreePath: dir,
      });

      expect(result.artifact.workflows.root.nodes[0]).toMatchObject({
        id: "current-club",
        kind: "parallel",
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: "generated-coverage",
            kind: "agent",
            needs: [
              "implement-current-club-state",
              "implement-club-picker-header",
              "implement-signout-reset",
            ],
            profile: "moka-verifier",
          }),
        ]),
      });
      expect(result.artifact.workflows.root.nodes).toHaveLength(2);
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
source_entrypoint: execute
task: Bad: compact scalar
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "execute",
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
    const schedule = buildScheduleYaml({
      scheduleId: "run-epic",
      task: "PIPE-41",
      nodes: [
        "- id: research",
        "  kind: agent",
        "  profile: moka-researcher",
        "- id: scheduler-context-red",
        "  kind: agent",
        "  profile: moka-test-writer",
        "  needs: [research]",
        "- id: pipe-41-7-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [scheduler-context-red]",
        "  task_context:",
        "    id: PIPE-41.7",
        "- id: pipe-41-8-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [scheduler-context-red]",
        "  task_context:",
        "    id: PIPE-41.8",
        "- id: scheduler-context-acceptance",
        "  kind: agent",
        "  profile: moka-acceptance-reviewer",
        "  needs: [pipe-41-7-green, pipe-41-8-green]",
        "- id: scheduler-context-verify",
        "  kind: agent",
        "  profile: moka-verifier",
        "  needs: [scheduler-context-acceptance]",
        "- id: merge",
        "  kind: builtin",
        "  builtin: drain-merge",
        "  needs: [scheduler-context-verify]",
        "- id: review",
        "  kind: agent",
        "  profile: moka-thermo-nuclear-reviewer",
        "  needs: [merge]",
      ],
    });

    try {
      const { prompt, result } = await generateScheduleWithPrompt({
        runId: "run-epic",
        schedule,
        task: "PIPE-41",
        worktreePath: dir,
      });

      expect(prompt).toContain("Planner mode: constrained agent graph");
      expect(prompt).toContain("Backlog work units:");
      expect(prompt).toContain("Backlog parent context:");
      expect(prompt).toContain("Agent-driven workflow scheduling");
      expect(prompt).toContain("PIPE-41.7");
      expect(prompt).toContain("PIPE-41.8");
      expect(prompt).toContain("Allowed profiles:");
      expect(prompt).toContain("moka-code-writer");
      expect(prompt).not.toContain("Allowed workflows:");
      expect(prompt).toContain("root_workflow: root");
      expect(prompt).toContain("Shape the graph by intent");
      expect(prompt).toContain(
        "Do not create a full RED/GREEN/ACCEPTANCE/VERIFY chain for each backlog ticket"
      );
      expect(prompt).toContain("red-test-file-policy");
      expect(prompt).toContain("changed_files:");
      expect(prompt).toContain("require_any:");
      expect(prompt).toContain(
        "Do not add blocking builtin test, lint, typecheck, or fallow nodes between RED test-writing nodes and GREEN implementation nodes."
      );
      expect(Object.keys(result.artifact.workflows)).toEqual(["root"]);
      expect(result.artifact.workflows.root.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "scheduler-context-red",
            kind: "agent",
            profile: "moka-test-writer",
          }),
          expect.objectContaining({
            id: "pipe-41-7-green",
            kind: "agent",
            profile: "moka-code-writer",
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
            profile: "moka-code-writer",
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
            profile: "moka-acceptance-reviewer",
          }),
          expect.objectContaining({
            id: "scheduler-context-verify",
            kind: "agent",
            needs: ["scheduler-context-acceptance"],
            profile: "moka-verifier",
          }),
        ])
      );
      compileScheduleArtifactOrThrow(result.artifact, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives planners lowercase Backlog ticket work units", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-lowercase-ticket-")
    );
    writeBacklogTask(
      dir,
      "jalgpall-2",
      "Adopt pg-boss for refresh queue + scheduler + retries",
      "## Description\n\nReplace the refresh queue.\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Refresh jobs are scheduled through pg-boss.\n<!-- AC:END -->",
      { parentTaskId: "" }
    );
    const schedule = buildScheduleYaml({
      scheduleId: "run-jalgpall-2",
      task: "jalgpall-2",
      nodes: [
        "- id: jalgpall-2-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  task_context:",
        "    id: jalgpall-2",
        "- id: jalgpall-2-verify",
        "  kind: agent",
        "  profile: moka-verifier",
        "  needs: [jalgpall-2-green]",
      ],
    });

    try {
      const { prompt, result } = await generateScheduleWithPrompt({
        runId: "run-jalgpall-2",
        schedule,
        task: "jalgpall-2",
        worktreePath: dir,
      });

      expect(prompt).toContain("Backlog work units:");
      expect(prompt).toContain("jalgpall-2");
      expect(prompt).toContain(
        "Adopt pg-boss for refresh queue + scheduler + retries"
      );
      expect(prompt).not.toContain("No backlog child tickets were resolved");
      expect(result.artifact.workflows.root.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "jalgpall-2-green",
            task_context: expect.objectContaining({
              acceptance_criteria: [
                {
                  id: "1",
                  text: "Refresh jobs are scheduled through pg-boss.",
                },
              ],
              description: "Replace the refresh queue.",
              id: "jalgpall-2",
              title: "Adopt pg-boss for refresh queue + scheduler + retries",
            }),
          }),
        ])
      );
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
    const schedule = buildScheduleYaml({
      scheduleId: "run-pc37",
      task: "PC-37",
      nodes: [
        "- id: research",
        "  kind: agent",
        "  profile: moka-researcher",
        "- id: pc-37-1-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [research]",
        "  task_context:",
        "    id: PC-37.1",
        "- id: pc-37-2-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [pc-37-1-green]",
        "  task_context:",
        "    id: PC-37.2",
        "- id: pc-37-3-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [pc-37-1-green]",
        "  task_context:",
        "    id: PC-37.3",
        "- id: pc-37-4-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [pc-37-2-green, pc-37-3-green]",
        "  task_context:",
        "    id: PC-37.4",
        "- id: verify",
        "  kind: agent",
        "  profile: moka-verifier",
        "  needs: [pc-37-4-green]",
      ],
    });

    try {
      const { prompt } = await generateScheduleWithPrompt({
        runId: "run-pc37",
        schedule,
        task: "PC-37",
        worktreePath: dir,
      });

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
source_entrypoint: execute
task: PC-37
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: moka-researcher
      - id: pc-37-1-green
        kind: agent
        profile: moka-code-writer
        needs: [research]
        task_context:
          id: PC-37.1
      - id: pc-37-2-green
        kind: agent
        profile: moka-code-writer
        needs: [research]
        task_context:
          id: PC-37.2
      - id: pc-37-3-green
        kind: agent
        profile: moka-code-writer
        needs: [research]
        task_context:
          id: PC-37.3
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [pc-37-1-green, pc-37-2-green, pc-37-3-green]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "execute",
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
    const schedule = buildScheduleYaml({
      scheduleId: "run-single",
      task: "PIPE-41.7",
      nodes: [
        "- id: research",
        "  kind: agent",
        "  profile: moka-researcher",
        "- id: pipe-41-7-red",
        "  kind: agent",
        "  profile: moka-test-writer",
        "  needs: [research]",
        "  task_context:",
        "    id: PIPE-41.7",
        "- id: pipe-41-7-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [pipe-41-7-red]",
        "  task_context:",
        "    id: PIPE-41.7",
        "- id: pipe-41-7-verify",
        "  kind: agent",
        "  profile: moka-verifier",
        "  needs: [pipe-41-7-green]",
        "  task_context:",
        "    id: PIPE-41.7",
      ],
    });

    try {
      const { prompt, result } = await generateScheduleWithPrompt({
        runId: "run-single",
        schedule,
        task: "PIPE-41.7",
        worktreePath: dir,
      });

      expect(prompt).toContain("id: PIPE-41.7");
      expect(prompt).not.toContain("id: PIPE-41.8");
      expect(result.artifact.workflows.root.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "pipe-41-7-green",
            profile: "moka-code-writer",
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
    const schedule = buildScheduleYaml({
      scheduleId: "run-multi-epic",
      task: "Execute PIPE-50 and PIPE-51",
      nodes: [
        "- id: pipe-50-1-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  task_context:",
        "    id: PIPE-50.1",
        "- id: pipe-50-1-1-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  needs: [pipe-50-1-green]",
        "  task_context:",
        "    id: PIPE-50.1.1",
        "- id: pipe-51-1-green",
        "  kind: agent",
        "  profile: moka-code-writer",
        "  task_context:",
        "    id: PIPE-51.1",
        "- id: verify",
        "  kind: agent",
        "  profile: moka-verifier",
        "  needs: [pipe-50-1-1-green, pipe-51-1-green]",
      ],
    });

    try {
      const { prompt } = await generateScheduleWithPrompt({
        runId: "run-multi-epic",
        schedule,
        task: "Execute PIPE-50 and PIPE-51",
        worktreePath: dir,
      });

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
source_entrypoint: execute
task: PIPE-41
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: moka-code-writer
        task_context:
          id: PIPE-41.7
          title: Propagate node context
      - id: verify
        kind: agent
        profile: moka-verifier
        needs: [implement]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: config(),
          entrypointId: "execute",
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

  it("rejects implementation nodes when no coverage-role profile can be generated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-schedule-agent-graph-"));
    const roleConfig = removeCoverageSchedulingRoles(config());
    const shortcut = `
version: 1
kind: pipeline-schedule
schedule_id: run-epic
source_entrypoint: execute
task: Ad hoc epic
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: moka-code-writer
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: roleConfig,
          entrypointId: "execute",
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

  it("rejects custom implementation-role nodes when no coverage-role profile can be generated", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-schedule-custom-implementation-")
    );
    const roleConfig = removeCoverageSchedulingRoles(
      configWithSchedulingRoles([
        {
          baseProfileId: "moka-code-writer",
          profileId: "custom-implementer",
          roles: ["implementation"],
        },
      ])
    );
    const shortcut = `
version: 1
kind: pipeline-schedule
schedule_id: run-custom-implementation
source_entrypoint: execute
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
          entrypointId: "execute",
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
        baseProfileId: "moka-code-writer",
        profileId: "moka-code-writer",
        roles: ["implementation"],
      },
      {
        baseProfileId: "moka-verifier",
        profileId: "custom-verifier",
        roles: ["coverage"],
      },
    ]);
    const covered = `
version: 1
kind: pipeline-schedule
schedule_id: run-custom-cover
source_entrypoint: execute
task: Covered implementation
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: moka-code-writer
      - id: verify
        kind: agent
        profile: custom-verifier
        needs: [implement]
`;

    try {
      await expect(
        generateScheduleArtifact({
          config: roleConfig,
          entrypointId: "execute",
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
        baseProfileId: "moka-code-writer",
        profileId: "custom-implementer",
        roles: ["implementation"],
      },
      {
        baseProfileId: "moka-verifier",
        profileId: "custom-verifier",
        roles: ["coverage"],
      },
    ]);
    const invalidSchedule = `
version: 1
kind: pipeline-schedule
schedule_id: run-custom-dependency
source_entrypoint: execute
task: PC-37
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: moka-researcher
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
          entrypointId: "execute",
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
source_entrypoint: execute
task: Covered implementation
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement-a
        kind: agent
        profile: moka-code-writer
      - id: implement-b
        kind: agent
        profile: moka-code-writer
      - id: aggregate
        kind: command
        command: [echo, aggregate]
        needs: [implement-a, implement-b]
      - id: verify
        kind: agent
        profile: moka-verifier
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
