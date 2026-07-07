import { Cause, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { BacklogTaskRecord } from "../tickets/backlog-task-store";
import type { TicketSelectionStrategy } from "../tickets/ticket-selection";
import type {
  ControllerDeps,
  LoopControllerEvent,
  MergePollSignal,
  SubmitRunInput,
  SubmitRunResult,
} from "./controller";
import { runLoopController } from "./controller";
import type { GhRunner, PrResolution } from "./gh-checks";

// ---------------------------------------------------------------------------
// Test doubles — every external effect is faked so the loop is deterministic
// and touches no real network / k8s / git.
// ---------------------------------------------------------------------------

/** Minimal task record factory — only fields the controller reads. */
const task = (
  id: string,
  dependencies: readonly string[] = []
): BacklogTaskRecord => ({
  acceptanceCriteria: [],
  dependencies,
  filePath: `backlog/tasks/${id}.md`,
  id,
  modifiedFiles: [],
  references: [],
  status: "To Do",
  title: `Ticket ${id}`,
});

/** A gh runner that never resolves anything by itself — the loop only calls
 * resolvePr / classifyChecks via injected seams in these tests, so the raw gh
 * is a stub that fails loudly if touched. */
const unusedGh: GhRunner = {
  json: (args) =>
    Effect.fail(new Error(`unexpected gh.json: ${args.join(" ")}`)),
  text: (args) =>
    Effect.fail(new Error(`unexpected gh.text: ${args.join(" ")}`)),
};

const FOUND_PR: Extract<PrResolution, { found: true }> = {
  found: true,
  headRefName: "moka/run/run-A",
  number: 1,
  url: "https://github.com/o/r/pull/1",
};

interface ScriptedDepsConfig {
  /** classify responses keyed by call index; defaults to "indeterminate". */
  readonly classifyResponses?: readonly MergePollSignal[];
  readonly maxMergePolls?: number;
  readonly maxRemediationAttempts?: number;
  /** Argo terminal phase per submit, keyed by call index; defaults Succeeded. */
  readonly phases?: readonly ("Succeeded" | "Failed" | "Error")[];
  readonly rootId?: string;
  readonly strategy?: TicketSelectionStrategy;
  readonly tasks: readonly BacklogTaskRecord[];
}

interface Recorder {
  readonly events: LoopControllerEvent[];
  readonly submits: SubmitRunInput[];
}

const buildDeps = (
  config: ScriptedDepsConfig
): {
  deps: ControllerDeps;
  recorder: Recorder;
} => {
  const events: LoopControllerEvent[] = [];
  const submits: SubmitRunInput[] = [];
  let classifyCount = 0;
  const classifyResponses = config.classifyResponses ?? [];
  const phases = config.phases ?? [];

  const deps: ControllerDeps = {
    classifyChecks: (_pr, _gh) => {
      const response = classifyResponses[classifyCount] ?? "indeterminate";
      classifyCount += 1;
      return Effect.succeed(response);
    },
    emit: (event) => {
      events.push(event);
      return Effect.void;
    },
    gh: unusedGh,
    loadGraph: () => Effect.succeed(config.tasks),
    maxMergePolls: config.maxMergePolls ?? 5,
    maxRemediationAttempts: config.maxRemediationAttempts ?? 2,
    merge: ({ classification, pr }) => {
      if (classification === "infra-down") {
        return Effect.succeed(Option.some({ _tag: "merged", pr: pr.number }));
      }
      return Effect.succeed(Option.none());
    },
    pollPhase: ({ workflowName }) => {
      // phase is keyed by submit order — find this submit's index by its runId.
      const index = submits.findIndex(
        (_, i) => `wf-run-${submits[i].ticketId}` === workflowName
      );
      const phase = phases[index] ?? "Succeeded";
      return Effect.succeed(phase);
    },
    projectId: "project-demo",
    refreshBacklog: () => Effect.succeed(config.tasks),
    resolvePr: (_runId, _gh) => Effect.succeed(FOUND_PR),
    rootId: config.rootId,
    sleep: () => Effect.void,
    strategy: config.strategy ?? "bfs",
    submitRun: (input: SubmitRunInput) => {
      submits.push(input);
      const runId = `run-${input.ticketId}`;
      const result: SubmitRunResult = {
        runId,
        workflowName: `wf-${runId}`,
      };
      return Effect.succeed(result);
    },
  };

  return {
    deps,
    recorder: { events, submits },
  };
};

const transitions = (events: LoopControllerEvent[]): string[] =>
  events
    .filter((e) => e.type === "loop.node.transition")
    .map((e) => `${e.ticketId}:${e.loopState}`);

// ---------------------------------------------------------------------------
// AC1 — 3-node chain drains in dependency order; each ends passed.
// ---------------------------------------------------------------------------

describe("runLoopController — AC1 dependency chain", () => {
  it("drains A->B->C in order with each node passed and merged", async () => {
    const { deps, recorder } = buildDeps({
      // Happy auto-merge path: each ticket's merge poll observes the PR landed,
      // signalled by classifyChecks returning "merged".
      classifyResponses: ["merged", "merged", "merged"],
      tasks: [task("A"), task("B", ["A"]), task("C", ["B"])],
    });

    const summary = await Effect.runPromise(runLoopController(deps));

    expect(summary.passed).toBe(3);
    expect(summary.blocked).toBe(0);

    // Traversal order: A fully drained before B before C.
    const order = recorder.submits.map((s) => s.ticketId);
    expect(order).toEqual(["A", "B", "C"]);

    // Per-node lifecycle queued is implicit (snapshot); transitions show
    // running -> merging -> passed for each, in order.
    expect(transitions(recorder.events)).toEqual([
      "A:running",
      "A:merging",
      "A:passed",
      "B:running",
      "B:merging",
      "B:passed",
      "C:running",
      "C:merging",
      "C:passed",
    ]);

    // snapshot at start + finish with counts.
    expect(recorder.events[0]?.type).toBe("loop.start");
    expect(recorder.events[1]?.type).toBe("loop.graph.snapshot");
    const finish = recorder.events.at(-1);
    expect(finish?.type).toBe("loop.finish");
    if (finish?.type === "loop.finish") {
      expect(finish.passed).toBe(3);
      expect(finish.blocked).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — fixable CI triggers bounded remediation in update-existing-pr mode.
// ---------------------------------------------------------------------------

describe("runLoopController — AC2 remediation loop", () => {
  it("remediates a fixable failure on the PR branch then merges", async () => {
    const { deps, recorder } = buildDeps({
      // first classify -> fixable (remediate), second -> merged.
      classifyResponses: ["fixable", "merged"],
      maxRemediationAttempts: 3,
      tasks: [task("A")],
    });

    const summary = await Effect.runPromise(runLoopController(deps));

    expect(summary.passed).toBe(1);
    expect(summary.blocked).toBe(0);

    // Two submits: the original create-new-pr, then the remediation
    // update-existing-pr carrying the PR head sha + moka/run/<runId> branch.
    expect(recorder.submits).toHaveLength(2);
    const [initial, remediation] = recorder.submits;
    expect(initial.deliveryMode).toBe("create-new-pr");

    expect(remediation.deliveryMode).toBe("update-existing-pr");
    expect(remediation.repositorySha).toBe(FOUND_PR.headRefName);
    expect(remediation.headBranch).toBe("moka/run/run-A");
  });

  it("caps remediation attempts and blocks when never green", async () => {
    const { deps, recorder } = buildDeps({
      // always fixable -> exhausts attempts.
      classifyResponses: [
        "fixable",
        "fixable",
        "fixable",
        "fixable",
        "fixable",
      ],
      maxRemediationAttempts: 2,
      tasks: [task("A")],
    });

    const summary = await Effect.runPromise(runLoopController(deps));

    expect(summary.passed).toBe(0);
    expect(summary.blocked).toBe(1);
    // 1 initial submit + at most maxRemediationAttempts remediation submits.
    expect(recorder.submits).toHaveLength(3);
    expect(transitions(recorder.events).at(-1)).toBe("A:blocked");
  });
});

// ---------------------------------------------------------------------------
// AC3 — infra-down admin merges; indeterminate waits then blocks; Failed
// pipeline blocks; exhausted remediation blocks but loop continues to the
// next independent ready ticket.
// ---------------------------------------------------------------------------

describe("runLoopController — AC3 classification outcomes", () => {
  it("admin-merges on infra-down and passes", async () => {
    const { deps } = buildDeps({
      classifyResponses: ["infra-down"],
      tasks: [task("A")],
    });
    const summary = await Effect.runPromise(runLoopController(deps));
    expect(summary.passed).toBe(1);
    expect(summary.blocked).toBe(0);
  });

  it("blocks on indeterminate after bounded waiting (never merges)", async () => {
    const { deps, recorder } = buildDeps({
      classifyResponses: [
        "indeterminate",
        "indeterminate",
        "indeterminate",
        "indeterminate",
        "indeterminate",
      ],
      maxMergePolls: 3,
      tasks: [task("A")],
    });
    const summary = await Effect.runPromise(runLoopController(deps));
    expect(summary.passed).toBe(0);
    expect(summary.blocked).toBe(1);
    expect(transitions(recorder.events).at(-1)).toBe("A:blocked");
    // Only the initial submit — no remediation for indeterminate.
    expect(recorder.submits).toHaveLength(1);
  });

  it("blocks when the pipeline phase is Failed (no PR resolution)", async () => {
    const { deps, recorder } = buildDeps({
      phases: ["Failed"],
      tasks: [task("A")],
    });
    const summary = await Effect.runPromise(runLoopController(deps));
    expect(summary.passed).toBe(0);
    expect(summary.blocked).toBe(1);
    expect(transitions(recorder.events)).toEqual(["A:running", "A:blocked"]);
  });

  it("continues to an independent ready ticket after one blocks", async () => {
    // A and B independent; A's pipeline fails (blocked), B passes.
    const { deps, recorder } = buildDeps({
      classifyResponses: ["merged"],
      phases: ["Failed", "Succeeded"],
      tasks: [task("A"), task("B")],
    });
    const summary = await Effect.runPromise(runLoopController(deps));
    expect(summary.passed).toBe(1);
    expect(summary.blocked).toBe(1);
    // Both attempted; B reaches passed.
    const order = recorder.submits.map((s) => s.ticketId);
    expect(order).toEqual(["A", "B"]);
    expect(transitions(recorder.events)).toContain("B:passed");
    expect(transitions(recorder.events)).toContain("A:blocked");
  });

  it("leaves a blocked node's dependents unreached", async () => {
    // A fails; B depends on A and is never ready -> never submitted.
    const { deps, recorder } = buildDeps({
      phases: ["Failed"],
      tasks: [task("A"), task("B", ["A"])],
    });
    const summary = await Effect.runPromise(runLoopController(deps));
    expect(summary.blocked).toBe(1);
    expect(summary.passed).toBe(0);
    const order = recorder.submits.map((s) => s.ticketId);
    expect(order).toEqual(["A"]);
    expect(transitions(recorder.events)).not.toContain("B:running");
  });
});

// ---------------------------------------------------------------------------
// Part B — configurable selection strategy threads to the selection call site.
// ---------------------------------------------------------------------------

describe("runLoopController — configurable strategy", () => {
  it("emits the configured strategy in loop.start", async () => {
    const { deps, recorder } = buildDeps({
      classifyResponses: ["merged"],
      strategy: "priority",
      tasks: [task("A")],
    });
    await Effect.runPromise(runLoopController(deps));
    const start = recorder.events.at(0);
    expect(start?.type).toBe("loop.start");
    if (start?.type === "loop.start") {
      expect(start).toMatchObject({
        projectId: "project-demo",
        strategy: "priority",
      });
    }
  });

  it("orders independent ready tickets by the priority strategy", async () => {
    // Two independent tickets; the low-priority one sorts first by id under bfs
    // but the priority strategy must surface the high-priority ticket first.
    const high: BacklogTaskRecord = { ...task("Z"), priority: "high" };
    const low: BacklogTaskRecord = { ...task("A"), priority: "low" };
    const { deps, recorder } = buildDeps({
      classifyResponses: ["merged", "merged"],
      strategy: "priority",
      tasks: [low, high],
    });
    await Effect.runPromise(runLoopController(deps));
    const order = recorder.submits.map((s) => s.ticketId);
    expect(order).toEqual(["Z", "A"]);
  });
});

// ---------------------------------------------------------------------------
// AC4 — cyclic backlog refuses to start, surfacing the cycle.
// ---------------------------------------------------------------------------

describe("runLoopController — AC4 cyclic backlog", () => {
  it("fails to start and surfaces the cycle", async () => {
    const { deps } = buildDeps({
      tasks: [task("A", ["B"]), task("B", ["A"])],
    });
    const exit = await Effect.runPromiseExit(runLoopController(deps));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      const error = Option.getOrThrow(failure);
      // The cycle is surfaced in the error message (A -> B -> A or similar).
      expect(error.message.toLowerCase()).toContain("cycle");
    }
  });
});
