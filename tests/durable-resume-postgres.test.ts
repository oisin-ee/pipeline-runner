import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { acquireRunJournal } from "../src/pipeline-runtime";
import type { RuntimeNodeResult } from "../src/runtime/contracts";
import type { RunJournal } from "../src/runtime/run-journal";
import { runWorkflowScheduler } from "../src/runtime/scheduler";
import type { WorkflowScheduleNode, WorkflowSchedulerInput } from "../src/runtime/scheduler";
import { setupLivePgDurableSuite } from "./live-pg-durable-suite";

// PIPE-91.5: kill/resume integration test for the journal cutover against the
// REAL cluster Postgres (no testcontainer, no tunnel). Set MOKA_PG_TEST_URL to
// the (port-forwarded) cluster db.url to run it; unset skips the suite so the
// default test run stays infra-free.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

const scheduleNode = (id: string, index: number, needs: string[] = []): WorkflowScheduleNode => ({
  dependents: [],
  id,
  index,
  needs,
});

const passedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output: `output of ${nodeId}`,
  status: "passed",
});

const schedulerInput = (
  overrides: Partial<WorkflowSchedulerInput> & Pick<WorkflowSchedulerInput, "nodes" | "runNode">,
): WorkflowSchedulerInput => ({
  failFast: false,
  isCancelled: () => false,
  markNodeReady: () => {},
  shouldContinueAfterNodeResult: (result) => result.status !== "failed",
  skipNode: () => {},
  ...overrides,
});

// Drive one scheduler pass with a freshly-acquired run journal. The journal is a
// scoped resource: its Postgres store is closed (and its writes flushed) when
// this Effect's scope exits, exactly as a real `moka run` invocation does.
const runWithRunJournal = async (
  runId: string,
  dbUrl: string,
  run: (journal: RunJournal | undefined) => Promise<unknown>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* effectBody() {
        const journal = yield* acquireRunJournal(runId, dbUrl);
        yield* Effect.promise(async () => await run(Option.getOrUndefined(journal)));
      }),
    ),
  );
};

type SchedulerResult = Awaited<ReturnType<typeof runWorkflowScheduler>>;

// Summarise a resumed run into a single comparable shape so each test asserts
// the resume outcome with one `expect` (the rerun set, the terminal outcome, and
// the completed-node order) rather than a repeated block of assertions.
const resumeSummary = (
  resumed: SchedulerResult | undefined,
  reran: string[],
): {
  completed: string[] | undefined;
  outcome: string | undefined;
  reran: string[];
} => ({
  completed: resumed?.completed.map((node) => node.nodeId),
  outcome: resumed?.outcome,
  reran,
});

describe("acquireRunJournal selection (no infra)", () => {
  it("resolves no journal when db.url is absent (byte-identical default)", async () => {
    const journal = await Effect.runPromise(Effect.scoped(acquireRunJournal("run-1")));
    expect(Option.isNone(journal)).toBe(true);
  });

  it("resolves no journal when runId is absent", async () => {
    const journal = await Effect.runPromise(Effect.scoped(acquireRunJournal(undefined, "postgres://unused")));
    expect(Option.isNone(journal)).toBe(true);
  });
});

describePg("durable run-journal cutover (live cluster PG)", () => {
  const dbUrl = PG_URL;
  const livePgDurableSuite = setupLivePgDurableSuite(dbUrl, "pgcutover");

  it("resumes a killed run from Postgres without re-running the finished node (AC1)", async () => {
    const id = livePgDurableSuite.runId("kill-resume");

    // First pass: "a" completes and is journaled to PG, then the run is "killed"
    // before "b" by cancelling once the first node finishes. Scope exit flushes
    // the write to Postgres and closes the connection.
    const firstRan: string[] = [];
    await runWithRunJournal(
      id,
      dbUrl,
      async (journal) =>
        await runWorkflowScheduler(
          schedulerInput({
            isCancelled: () => firstRan.length >= 1,
            journal,
            nodes: [scheduleNode("a", 0), scheduleNode("b", 1, ["a"])],
            runNode: async (nodeId) => {
              firstRan.push(nodeId);
              return passedResult(nodeId);
            },
          }),
        ),
    );
    expect(firstRan).toEqual(["a"]);

    // Resume: a fresh journal is acquired, hydrating a NEW Postgres store scoped
    // to this runId. "a" is read back from PG and never re-run; only "b" runs.
    const resumedRan: string[] = [];
    let resumed: SchedulerResult | undefined;
    await runWithRunJournal(id, dbUrl, async (journal) => {
      resumed = await runWorkflowScheduler(
        schedulerInput({
          journal,
          nodes: [scheduleNode("a", 0), scheduleNode("b", 1, ["a"])],
          runNode: async (nodeId) => {
            resumedRan.push(nodeId);
            return passedResult(nodeId);
          },
        }),
      );
    });

    expect(resumeSummary(resumed, resumedRan)).toEqual({
      completed: ["a", "b"],
      outcome: "PASS",
      reran: ["b"],
    });
  });

  it("isolates resume by runId — concurrent runs each replay only their own records (AC4)", async () => {
    const idA = livePgDurableSuite.runId("iso-A");
    const idB = livePgDurableSuite.runId("iso-B");
    const firstA: string[] = [];
    const firstB: string[] = [];

    // Kill both runs after their first node, concurrently. Run A's graph is a,b;
    // run B's graph is p,q — disjoint node ids so cross-run leakage is visible.
    await Promise.all([
      runWithRunJournal(
        idA,
        dbUrl,
        async (journal) =>
          await runWorkflowScheduler(
            schedulerInput({
              isCancelled: () => firstA.length >= 1,
              journal,
              nodes: [scheduleNode("a", 0), scheduleNode("b", 1, ["a"])],
              runNode: async (nodeId) => {
                firstA.push(nodeId);
                return passedResult(nodeId);
              },
            }),
          ),
      ),
      runWithRunJournal(
        idB,
        dbUrl,
        async (journal) =>
          await runWorkflowScheduler(
            schedulerInput({
              isCancelled: () => firstB.length >= 1,
              journal,
              nodes: [scheduleNode("p", 0), scheduleNode("q", 1, ["p"])],
              runNode: async (nodeId) => {
                firstB.push(nodeId);
                return passedResult(nodeId);
              },
            }),
          ),
      ),
    ]);
    expect(firstA).toEqual(["a"]);
    expect(firstB).toEqual(["p"]);

    // Resume run A: it must see only "a" (its own record) and run "b" — never a
    // node from run B's namespace.
    const resumedA: string[] = [];
    let outcomeA: SchedulerResult | undefined;
    await runWithRunJournal(idA, dbUrl, async (journal) => {
      outcomeA = await runWorkflowScheduler(
        schedulerInput({
          journal,
          nodes: [scheduleNode("a", 0), scheduleNode("b", 1, ["a"])],
          runNode: async (nodeId) => {
            resumedA.push(nodeId);
            return passedResult(nodeId);
          },
        }),
      );
    });
    expect(resumeSummary(outcomeA, resumedA)).toEqual({
      completed: ["a", "b"],
      outcome: "PASS",
      reran: ["b"],
    });

    // Resume run B independently: only "p" hydrated, only "q" re-run.
    const resumedB: string[] = [];
    await runWithRunJournal(
      idB,
      dbUrl,
      async (journal) =>
        await runWorkflowScheduler(
          schedulerInput({
            journal,
            nodes: [scheduleNode("p", 0), scheduleNode("q", 1, ["p"])],
            runNode: async (nodeId) => {
              resumedB.push(nodeId);
              return passedResult(nodeId);
            },
          }),
        ),
    );
    expect(resumedB).toEqual(["q"]);
  });
});
