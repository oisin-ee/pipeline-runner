import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parsePipelineConfigParts } from "../src/config";
import type { PipelineConfig } from "../src/config";
import { resumeRun } from "../src/pipeline-runtime";
import type { RunnerLaunchPlan } from "../src/runner";
import type { RuntimeNodeResult } from "../src/runtime/contracts";
import { postgresDurableRunStore } from "../src/runtime/durable-store/postgres/postgres-store";
import { setupLivePgDurableSuite } from "./live-pg-durable-suite";

// PIPE-91.8: kill/resume integration test for `moka resume` against the REAL
// cluster Postgres (no testcontainer, no tunnel). Set MOKA_PG_TEST_URL to the
// (port-forwarded) cluster db.url to run the live suite; unset skips it so the
// default test run stays infra-free.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

const NO_STORE_ERROR = /no durable store is configured/u;
const NO_PERSISTED_STATE_ERROR = /no persisted node results were found/u;

const tempDirs: string[] = [];

const tempProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "moka-resume-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A two-node sequential workflow (a -> b): the smallest graph that proves the
// resume seed skips a completed node while still running its dependent.
const twoNodeConfig = (): PipelineConfig =>
  parsePipelineConfigParts({
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
      - id: b
        kind: agent
        profile: b
        needs: [a]
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
    tools: []
  a:
    runner: opencode
    instructions: { inline: Agent A }
    output: { format: text }
  b:
    runner: opencode
    instructions: { inline: Agent B }
    output: { format: text }
`,
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
  });

const passedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output: `output of ${nodeId}`,
  status: "passed",
});

// A recording executor: every spawned node id is captured so the test can assert
// exactly which nodes the resumed run actually re-ran.
const recordingExecutor = (ran: string[]) => (plan: RunnerLaunchPlan) => {
  ran.push(plan.nodeId);
  return { exitCode: 0, stdout: `output of ${plan.nodeId}` };
};

// Seed a node's terminal result into the cluster Postgres for `runId`, then close
// the store so the write is flushed — the exact state a process that journaled
// the node and then died leaves behind.
const seedPersistedNodes = async (
  dbUrl: string,
  runId: string,
  nodeIds: string[]
): Promise<void> => {
  const store = await postgresDurableRunStore(dbUrl, runId);
  const journal = store.toRunJournal(runId);
  for (const nodeId of nodeIds) {
    journal.record(passedResult(nodeId));
  }
  await store.close();
};

describe("resumeRun (no infra)", () => {
  it("rejects resume when no durable store is configured (AC2)", async () => {
    const ran: string[] = [];
    await expect(
      resumeRun({
        config: twoNodeConfig(),
        dbUrl: undefined,
        executor: recordingExecutor(ran),
        runId: "missing-run",
        task: "resume without a store",
        worktreePath: tempProject(),
      })
    ).rejects.toThrow(NO_STORE_ERROR);
    expect(ran).toEqual([]);
  });
});

describePg("moka resume against the live cluster Postgres", () => {
  const dbUrl = PG_URL;
  const livePgDurableSuite = setupLivePgDurableSuite(dbUrl, "pgresume");

  it("resumes a killed run from Postgres without re-running the finished node (AC1)", async () => {
    const id = livePgDurableSuite.runId("kill-resume");
    // A prior process completed and journaled "a" before dying.
    await seedPersistedNodes(dbUrl, id, ["a"]);

    // Fresh process: resume acquires a NEW Postgres store scoped to this runId,
    // replays "a" from the journal, and runs only the unfinished "b".
    const ran: string[] = [];
    const result = await resumeRun({
      config: twoNodeConfig(),
      dbUrl,
      executor: recordingExecutor(ran),
      runId: id,
      task: "resume the killed run",
      worktreePath: tempProject(),
    });

    expect({
      completed: result.nodes.map((node) => node.nodeId).toSorted(),
      outcome: result.outcome,
      ran,
    }).toEqual({
      completed: ["a", "b"],
      outcome: "PASS",
      ran: ["b"],
    });
  });

  it("fails with a clear error when the runId has no persisted state (AC2)", async () => {
    const id = livePgDurableSuite.runId("unknown");
    const ran: string[] = [];

    await expect(
      resumeRun({
        config: twoNodeConfig(),
        dbUrl,
        executor: recordingExecutor(ran),
        runId: id,
        task: "resume a never-persisted run",
        worktreePath: tempProject(),
      })
    ).rejects.toThrow(NO_PERSISTED_STATE_ERROR);
    expect(ran).toEqual([]);
  });

  it("rehydrates only its own (runId,nodeId) records — no cross-run bleed (AC3)", async () => {
    const idA = livePgDurableSuite.runId("iso-A");
    const idB = livePgDurableSuite.runId("iso-B");
    // Run B is fully complete (a AND b journaled); run A only completed "a".
    // The graphs share node ids, so if B's "b" record bled into A's resume, A
    // would skip "b" and run nothing — the assertion below would then fail.
    await seedPersistedNodes(dbUrl, idB, ["a", "b"]);
    await seedPersistedNodes(dbUrl, idA, ["a"]);

    const ranA: string[] = [];
    const result = await resumeRun({
      config: twoNodeConfig(),
      dbUrl,
      executor: recordingExecutor(ranA),
      runId: idA,
      task: "resume run A on the shared DB",
      worktreePath: tempProject(),
    });

    expect({ outcome: result.outcome, ranA }).toEqual({
      outcome: "PASS",
      ranA: ["b"],
    });
  });
});
