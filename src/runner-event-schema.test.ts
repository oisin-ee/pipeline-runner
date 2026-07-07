import { describe, expect, it } from "vitest";

import type { RunnerEventRecord } from "./runner-command-contract";
import { runnerEventRecordSchema } from "./runner-event-schema";
import { parseWithSchema } from "./schema-boundary";
import { loopStateSchema } from "./tickets/ticket-graph-dto";

const ENVELOPE = {
  at: "2026-06-21T00:00:00.000Z",
  runId: "run-123",
  sequence: 1,
};
const PR_DELIVERY_ACTIONS: ("opened" | "updated")[] = ["opened", "updated"];

const expectEventType: <T extends RunnerEventRecord["type"]>(
  event: RunnerEventRecord,
  type: T
) => asserts event is Extract<RunnerEventRecord, { type: T }> = (
  event,
  type
) => {
  expect(event.type).toBe(type);
  if (event.type !== type) {
    throw new Error(`Expected ${type}, received ${event.type}`);
  }
};

const parseRunnerEvent = (event: unknown): RunnerEventRecord =>
  parseWithSchema(runnerEventRecordSchema, event);

describe("loop.* event definitions — AC1: round-trip through runnerEventRecordSchema", () => {
  it("loop.start round-trips with projectId, strategy, and optional root", () => {
    const event = {
      ...ENVELOPE,
      loopStart: {
        projectId: "pipeline-console",
        strategy: "topological",
      },
      type: "loop.start",
    };
    const parsed = parseRunnerEvent(event);
    expectEventType(parsed, "loop.start");
    expect(parsed.loopStart).toEqual({
      projectId: "pipeline-console",
      strategy: "topological",
    });
  });

  it("loop.start accepts an optional root field", () => {
    const event = {
      ...ENVELOPE,
      loopStart: {
        projectId: "pipeline-console",
        root: "PIPE-1",
        strategy: "topological",
      },
      type: "loop.start",
    };
    const parsed = parseRunnerEvent(event);
    expectEventType(parsed, "loop.start");
    expect(parsed.loopStart.root).toBe("PIPE-1");
  });

  it("loop.graph.snapshot round-trips a ticket-graph wire DTO", () => {
    const event = {
      ...ENVELOPE,
      loopGraphSnapshot: {
        batches: [["A"], ["B"]],
        dangling: [],
        edges: [{ from: "A", to: "B" }],
        nodes: [
          {
            id: "A",
            loopState: "queued",
            status: "To Do",
            title: "Task A",
          },
          {
            id: "B",
            loopState: "running",
            priority: "high",
            status: "In Progress",
            title: "Task B",
          },
        ],
      },
      type: "loop.graph.snapshot",
    };
    const parsed = parseRunnerEvent(event);
    expectEventType(parsed, "loop.graph.snapshot");
    const snap = parsed.loopGraphSnapshot;
    expect(snap.batches).toStrictEqual([["A"], ["B"]]);
    expect(snap.edges).toStrictEqual([{ from: "A", to: "B" }]);
    expect(snap.nodes[0].loopState).toBe("queued");
    expect(snap.nodes[1].loopState).toBe("running");
  });

  it("loop.node.transition round-trips ticketId and loopState", () => {
    const event = {
      ...ENVELOPE,
      loopNodeTransition: { loopState: "passed", ticketId: "PIPE-5" },
      type: "loop.node.transition",
    };
    const parsed = parseRunnerEvent(event);
    expectEventType(parsed, "loop.node.transition");
    expect(parsed.loopNodeTransition.loopState).toBe("passed");
    expect(parsed.loopNodeTransition.ticketId).toBe("PIPE-5");
  });

  it("loop.finish round-trips passed/blocked counts", () => {
    const event = {
      ...ENVELOPE,
      loopFinish: { blocked: 2, passed: 7 },
      type: "loop.finish",
    };
    const parsed = parseRunnerEvent(event);
    expectEventType(parsed, "loop.finish");
    expect(parsed.loopFinish.passed).toBe(7);
    expect(parsed.loopFinish.blocked).toBe(2);
  });

  it("rejects loop.node.transition with invalid loopState", () => {
    const event = {
      ...ENVELOPE,
      loopNodeTransition: { loopState: "UNKNOWN", ticketId: "T1" },
      type: "loop.node.transition",
    };
    expect(() => parseWithSchema(runnerEventRecordSchema, event)).toThrow();
  });
});

describe("delivery.pull-request event schema", () => {
  it.each(PR_DELIVERY_ACTIONS)(
    "round-trips a %s pull-request delivery event",
    (action) => {
      const event = {
        ...ENVELOPE,
        deliveryPullRequest: {
          action,
          url: `https://github.com/owner/repo/pull/${action === "opened" ? "1" : "2"}`,
        },
        type: "delivery.pull-request",
      };

      const parsed = parseRunnerEvent(event);

      expectEventType(parsed, "delivery.pull-request");
      expect(parsed.deliveryPullRequest).toEqual(event.deliveryPullRequest);
    }
  );
});

describe("loopState — AC3: single exported source of truth", () => {
  it("loopStateSchema owns one canonical owner in ticket-graph-dto", () => {
    // Loop event definitions and this test both import loopStateSchema from the
    // DTO module — one canonical owner, no duplicate enum.
    expect(parseWithSchema(loopStateSchema, "queued")).toBe("queued");
    expect(parseWithSchema(loopStateSchema, "blocked")).toBe("blocked");
    expect(() => parseWithSchema(loopStateSchema, "done")).toThrow();
  });

  it("loop.graph.snapshot rejects an invalid loopState in a node", () => {
    const event = {
      ...ENVELOPE,
      loopGraphSnapshot: {
        batches: [],
        dangling: [],
        edges: [],
        nodes: [
          {
            id: "A",
            loopState: "NOT_A_STATE",
            status: "To Do",
            title: "A",
          },
        ],
      },
      type: "loop.graph.snapshot",
    };
    expect(() => parseWithSchema(runnerEventRecordSchema, event)).toThrow();
  });
});
