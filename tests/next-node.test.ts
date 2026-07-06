import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parsePipelineConfigParts } from "../src/config";
import {
  buildNextNodeEnvelope,
  buildNextNodeEnvelopeFromRunStore,
  registerNextNodeSubcommand,
} from "../src/run-control/next-node";
import { fileRunControlStore } from "../src/run-control/run-control-store";
import type { AcceptanceCriterion } from "../src/runtime/contracts/contracts";
import { inMemoryDurableRunStore } from "../src/runtime/durable-store/durable-store";
import type { WorkflowScheduleNode } from "../src/runtime/scheduler";
import { computeReadyNodeIds } from "../src/runtime/scheduler";

const MISSING_PERSISTED_SCHEDULE_RE = /persisted schedule.*moka next node/iu;
const UNKNOWN_SCHEDULE_FILE_OPTION_RE = /unknown option '--schedule-file'/iu;
const SCHEDULE_FILE_MIGRATION_RE = /remove --schedule-file.*Moka DB/iu;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const node = (id: string, index: number, needs: string[] = [], dependents: string[] = []): WorkflowScheduleNode => ({
  dependents,
  id,
  index,
  needs,
});

const passedResult = (nodeId: string, output = `output-of-${nodeId}`) => ({
  attempts: 1,
  evidence: [],
  exitCode: 0,
  nodeId,
  output,
  status: "passed" as const,
});

// ---------------------------------------------------------------------------
// computeReadyNodeIds (pure unit tests)
// ---------------------------------------------------------------------------

describe("computeReadyNodeIds", () => {
  it("returns all root nodes when nothing has completed", () => {
    const nodes = [node("a", 0), node("b", 1)];
    expect(computeReadyNodeIds({ nodes })).toEqual(["a", "b"]);
  });

  it("unlocks a dependent once its need has passed", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [passedResult("a")];
    expect(computeReadyNodeIds({ completed, nodes })).toEqual(["b"]);
  });

  it("does not make a dependent ready when its need failed and no override", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [{ ...passedResult("a"), exitCode: 1, status: "failed" as const }];
    expect(computeReadyNodeIds({ completed, nodes })).toEqual([]);
  });

  it("uses shouldContinueAfterNodeResult to override the default failure-blocking", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [{ ...passedResult("a"), exitCode: 1, status: "failed" as const }];
    // Treat all results as continuing — even failures unblock dependents.
    expect(
      computeReadyNodeIds({
        completed,
        nodes,
        shouldContinueAfterNodeResult: () => true,
      }),
    ).toEqual(["b"]);
  });

  it("excludes already-running nodes from the ready list", () => {
    const nodes = [node("a", 0), node("b", 1)];
    expect(computeReadyNodeIds({ nodes, running: ["a"] })).toEqual(["b"]);
  });

  it("excludes blocked nodes", () => {
    const nodes = [node("a", 0), node("b", 1)];
    expect(computeReadyNodeIds({ blocked: ["b"], nodes })).toEqual(["a"]);
  });

  it("returns empty when all nodes are completed", () => {
    const nodes = [node("a", 0), node("b", 1, ["a"])];
    const completed = [passedResult("a"), passedResult("b")];
    expect(computeReadyNodeIds({ completed, nodes })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildNextNodeEnvelope (integration — in-memory store seeded with real data)
// ---------------------------------------------------------------------------

describe("buildNextNodeEnvelope", () => {
  const RUN_ID = "test-run-001";

  const criteria: AcceptanceCriterion[] = [{ id: "ac-1", text: "Output contains the word hello" }];

  const nodes = [node("setup", 0), node("work", 1, ["setup"])];

  const nodeMetadata = new Map([
    ["setup", { criteria: [], prompt: "Run the setup script" }],
    ["work", { criteria, prompt: "Do the main work" }],
  ]);

  it("emits the envelope for the first ready node (setup) with an empty store", () => {
    const store = inMemoryDurableRunStore();
    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });

    expect(envelope).toEqual({
      criteria: [],
      nodeId: "setup",
      prompt: "Run the setup script",
      runId: RUN_ID,
      upstreamOutputs: [],
    });
  });

  it("advances to the next ready node after upstream completes", () => {
    const store = inMemoryDurableRunStore();
    const setupResult = passedResult("setup", "setup completed ok");
    store.record(RUN_ID, "setup", {
      criteria: [],
      inputs: undefined,
      result: { ...setupResult },
    });

    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });

    expect(envelope?.nodeId).toBe("work");
    expect(envelope?.prompt).toBe("Do the main work");
    expect(envelope?.criteria).toEqual(criteria);
    expect(envelope?.upstreamOutputs).toEqual([{ nodeId: "setup", output: "setup completed ok" }]);
    expect(envelope?.runId).toBe(RUN_ID);
  });

  it("returns undefined when all nodes have passed (run complete)", () => {
    const store = inMemoryDurableRunStore();
    store.record(RUN_ID, "setup", {
      criteria: [],
      inputs: undefined,
      result: passedResult("setup"),
    });
    store.record(RUN_ID, "work", {
      criteria,
      inputs: undefined,
      result: passedResult("work"),
    });

    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });
    expect(envelope).toBeUndefined();
  });

  it("returns undefined when the remaining node is blocked by an upstream failure", () => {
    const store = inMemoryDurableRunStore();
    store.record(RUN_ID, "setup", {
      criteria: [],
      inputs: undefined,
      result: { ...passedResult("setup"), exitCode: 1, status: "failed" },
    });

    // "work" needs "setup" which failed — no shouldContinueAfterNodeResult override,
    // so "work" is not ready.
    const envelope = buildNextNodeEnvelope({
      nodeMetadata,
      nodes,
      runId: RUN_ID,
      store,
    });
    expect(envelope).toBeUndefined();
  });

  it("includes upstream outputs only for direct needs, not transitive ancestors", () => {
    const threeNodes = [node("a", 0), node("b", 1, ["a"]), node("c", 2, ["b"])];
    const meta = new Map([
      ["a", { criteria: [], prompt: "step a" }],
      ["b", { criteria: [], prompt: "step b" }],
      ["c", { criteria: [], prompt: "step c" }],
    ]);
    const store = inMemoryDurableRunStore();
    store.record(RUN_ID, "a", {
      criteria: [],
      inputs: undefined,
      result: passedResult("a", "a-output"),
    });
    store.record(RUN_ID, "b", {
      criteria: [],
      inputs: undefined,
      result: passedResult("b", "b-output"),
    });

    const envelope = buildNextNodeEnvelope({
      nodeMetadata: meta,
      nodes: threeNodes,
      runId: RUN_ID,
      store,
    });

    expect(envelope?.nodeId).toBe("c");
    // "c" directly needs "b" only — "a" is a transitive ancestor and excluded.
    expect(envelope?.upstreamOutputs).toEqual([{ nodeId: "b", output: "b-output" }]);
  });
});

describe("registerNextNodeSubcommand", () => {
  it("hides and rejects the legacy --schedule-file flag with migration guidance", async () => {
    const program = new Command("moka").exitOverride();
    const stderr: string[] = [];
    program.configureOutput({ writeErr: (chunk) => stderr.push(chunk) });
    const next = program.command("next");
    registerNextNodeSubcommand(next);

    const nodeCommand = next.commands.find((command) => command.name() === "node");
    expect(nodeCommand?.helpInformation()).not.toContain("--schedule-file");

    await expect(
      program.parseAsync(["next", "node", "run-with-schedule", "--schedule-file", "schedule.yaml"], { from: "user" }),
    ).rejects.toThrow(UNKNOWN_SCHEDULE_FILE_OPTION_RE);
    expect(stderr.join("")).toMatch(SCHEDULE_FILE_MIGRATION_RE);
  });
});

const manifestScheduleConfig = () =>
  parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: pkg-default
        kind: command
        command: ["node", "-e", "console.log('wrong graph')"]
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: command
    instructions: { inline: Orchestrate }
    tools: []
`,
    runners: `
version: 1
runners:
  command:
    type: command
    command: node
    args: ["-e", "{{prompt}}"]
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
  });

const persistedScheduleYaml = (): string =>
  [
    "kind: pipeline-schedule",
    "version: 1",
    "schedule_id: persisted-next",
    "generated_at: 2026-06-27T00:00:00.000Z",
    "source_entrypoint: quick",
    "root_workflow: root",
    'task: "persisted next node"',
    "workflows:",
    "  root:",
    "    nodes:",
    "      - id: plan",
    "        kind: command",
    '        command: ["node", "-e", "console.log(\'plan\')"]',
    "        task_context:",
    "          description: Plan from persisted schedule",
    "          acceptance_criteria:",
    "            - id: ac-plan",
    "              text: Plan ready",
    "      - id: implement",
    "        kind: command",
    '        command: ["node", "-e", "console.log(\'implement\')"]',
    "        needs: [plan]",
    "",
  ].join("\n");

describe("buildNextNodeEnvelopeFromRunStore", () => {
  it("reads the persisted manifest schedule by runId and emits the first node", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "next-node-run-store-"));
    try {
      const runId = "run-store-schedule";
      const runControlStore = fileRunControlStore(workspaceRoot);
      await Effect.runPromise(
        runControlStore.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["plan", "implement"],
          runId,
          schedule: persistedScheduleYaml(),
          target: "local",
        }),
      );

      const envelope = await Effect.runPromise(
        buildNextNodeEnvelopeFromRunStore({
          config: manifestScheduleConfig(),
          durableStore: inMemoryDurableRunStore(),
          runControlStore,
          runId,
          worktreePath: workspaceRoot,
        }),
      );

      expect(envelope).toEqual({
        criteria: [{ id: "ac-plan", text: "Plan ready" }],
        nodeId: "plan",
        prompt: "Plan from persisted schedule",
        runId,
        upstreamOutputs: [],
      });
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("fails clearly when the run manifest has no persisted schedule", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "next-node-no-schedule-"));
    try {
      const runId = "run-without-schedule";
      const runControlStore = fileRunControlStore(workspaceRoot);
      await Effect.runPromise(
        runControlStore.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["pkg-default"],
          runId,
          target: "local",
        }),
      );

      await expect(
        Effect.runPromise(
          buildNextNodeEnvelopeFromRunStore({
            config: manifestScheduleConfig(),
            durableStore: inMemoryDurableRunStore(),
            runControlStore,
            runId,
            worktreePath: workspaceRoot,
          }),
        ),
      ).rejects.toThrow(MISSING_PERSISTED_SCHEDULE_RE);
    } finally {
      rmSync(workspaceRoot, { force: true, recursive: true });
    }
  });
});
