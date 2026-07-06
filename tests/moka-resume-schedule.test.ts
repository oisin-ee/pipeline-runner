import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { parsePipelineConfigParts } from "../src/config";
import type { PipelineConfig } from "../src/config";
import { resumeRun } from "../src/pipeline-runtime";
import { compileScheduleArtifact, parseScheduleArtifact } from "../src/planning/generate";
import {
  migratePostgresRunControlStore,
  postgresRunControlStore,
} from "../src/run-control/postgres/postgres-run-control-store";
import type { PostgresRunControlStore } from "../src/run-control/postgres/postgres-run-control-store";
import type { RuntimeNodeResult } from "../src/runtime/contracts";
import { postgresDurableRunStore } from "../src/runtime/durable-store/postgres/postgres-store";

// PIPE-91.16: prove `moka resume` rebuilds the run's ORIGINAL graph from the
// schedule artifact persisted on the run-control manifest at createRun — NOT the
// package default workflow. Live cluster Postgres only (set MOKA_PG_TEST_URL to
// the port-forwarded db.url); unset skips so the default run stays infra-free.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

const tempDirs: string[] = [];

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const initGitRepo = (worktreePath: string): void => {
  execFileSync("git", ["init", "--quiet"], { cwd: worktreePath });
};

const gitStatusPorcelain = (worktreePath: string): string[] =>
  execFileSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A package config whose DEFAULT workflow runs the WRONG node (`pkg-default`).
// If resume recompiled from this config instead of the persisted schedule, it
// would run `pkg-default` — the marker assertion below would then fail. The only
// runner is `command`, so resume never tries to lease an opencode server.
const packageConfig = (markerDir: string): PipelineConfig =>
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
        command: ["sh", "-c", "echo wrong > '${markerDir}/pkg-default'"]
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

// A custom three-node sequential schedule (step-one -> step-two -> step-three),
// distinct from the package default workflow. Each node drops a marker file so
// the test can assert exactly which nodes the resumed run executed.
const customScheduleYaml = (markerDir: string): string =>
  [
    "kind: pipeline-schedule",
    "version: 1",
    "schedule_id: custom-graph",
    "generated_at: 2026-06-27T00:00:00.000Z",
    "source_entrypoint: quick",
    "root_workflow: root",
    'task: "persist + resume the exact run graph"',
    "workflows:",
    "  root:",
    "    nodes:",
    "      - id: step-one",
    "        kind: command",
    `        command: ["sh", "-c", "echo one > '${markerDir}/step-one'"]`,
    "      - id: step-two",
    "        kind: command",
    `        command: ["sh", "-c", "echo two > '${markerDir}/step-two'"]`,
    "        needs: [step-one]",
    "      - id: step-three",
    "        kind: command",
    `        command: ["sh", "-c", "echo three > '${markerDir}/step-three'"]`,
    "        needs: [step-two]",
    "",
  ].join("\n");

const passedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output: `output of ${nodeId}`,
  status: "passed",
});

// Seed a node's terminal result into the cluster Postgres durable journal for
// `runId`, then close so the write flushes — exactly what a process that ran the
// node and then died leaves behind.
const seedPersistedNodes = async (dbUrl: string, runId: string, nodeIds: string[]): Promise<void> => {
  const store = await postgresDurableRunStore(dbUrl, runId);
  const journal = store.toRunJournal(runId);
  for (const nodeId of nodeIds) {
    journal.record(passedResult(nodeId));
  }
  await store.close();
};

describePg("moka resume reconstructs the persisted run graph (live PG)", () => {
  vi.setConfig({ hookTimeout: 90_000, testTimeout: 90_000 });
  const dbUrl = PG_URL;
  const suitePrefix = `pgresumesched-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const openStores: PostgresRunControlStore[] = [];
  let admin: postgres.Sql;
  let counter = 0;

  const runId = (label: string): string => {
    counter += 1;
    return `${suitePrefix}-${label}-${counter}`;
  };

  const pgStore = (): PostgresRunControlStore => {
    const store = postgresRunControlStore(dbUrl);
    openStores.push(store);
    return store;
  };

  beforeAll(async () => {
    await migratePostgresRunControlStore(dbUrl);
    admin = postgres(dbUrl, { max: 1 });
  });

  afterAll(async () => {
    for (const store of openStores) {
      await store.close();
    }
    const like = `${suitePrefix}%`;
    await admin`delete from moka_run_control_node_artifact where run_id like ${like}`;
    await admin`delete from moka_run_control_node_session where run_id like ${like}`;
    await admin`delete from moka_run_control_event where run_id like ${like}`;
    await admin`delete from moka_run_control_run where run_id like ${like}`;
    await admin`delete from moka_durable_node_record where run_id like ${like}`;
    await admin`delete from moka_durable_run where run_id like ${like}`;
    await admin.end();
  });

  it("persists the schedule at start and resumes only the unfinished nodes of that graph (AC1, AC2)", async () => {
    const id = runId("custom");
    const markerDir = tempDir("moka-resume-sched-markers-");
    const worktreePath = tempDir("moka-resume-sched-work-");
    initGitRepo(worktreePath);
    const config = packageConfig(markerDir);
    const scheduleYaml = customScheduleYaml(markerDir);

    // The start path compiles the schedule (same compile resume will use) and
    // registers the run's node ids.
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(scheduleYaml, "schedule.yaml"),
      worktreePath,
    );
    const nodeIds = compiled.plan.topologicalOrder.map((node) => node.id);

    // createRun persists the schedule artifact on the run-control manifest.
    const store = pgStore();
    await Effect.runPromise(
      store.createRun({
        effort: "normal",
        mode: "write",
        nodeIds,
        runId: id,
        schedule: scheduleYaml,
        target: "local",
      }),
    );

    // AC1: the schedule is retrievable by runId from Postgres.
    const rows = await admin`
      select manifest->>'schedule' as schedule
      from moka_run_control_run where run_id = ${id}
    `;
    expect(rows[0]?.schedule).toContain("kind: pipeline-schedule");
    expect(rows[0]?.schedule).toContain("step-three");

    // A prior process ran and journaled `step-one` before dying.
    await seedPersistedNodes(dbUrl, id, ["step-one"]);

    // Resume WITHOUT a workflow/entrypoint: the only way to run the right nodes
    // is to rebuild the graph from the persisted schedule. The base config's
    // default workflow would run `pkg-default` instead (the bug).
    const result = await resumeRun({
      config,
      dbUrl,
      runId: id,
      task: "resume the killed custom run",
      worktreePath,
    });

    // AC2: only the unfinished nodes of the ORIGINAL graph ran. `step-one` was
    // replayed from the journal (skipped, no marker); `pkg-default` never ran.
    expect({
      gitStatus: gitStatusPorcelain(worktreePath),
      markers: readdirSync(markerDir).toSorted(),
      nodes: result.nodes.map((node) => node.nodeId).toSorted(),
      outcome: result.outcome,
      workflowId: compiled.workflowId,
    }).toEqual({
      gitStatus: [],
      markers: ["step-three", "step-two"],
      nodes: ["step-one", "step-three", "step-two"],
      outcome: "PASS",
      workflowId: "schedule-custom-graph-root",
    });
  });
});
