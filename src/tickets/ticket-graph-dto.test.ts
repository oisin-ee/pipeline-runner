import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { BacklogTaskRecord } from "./backlog-task-store";
import { buildTicketGraphEffect } from "./ticket-graph";
import {
  type LoopState,
  loopStateSchema,
  serializeTicketGraph,
  ticketGraphDtoSchema,
} from "./ticket-graph-dto";

// Minimal task factory — only the fields ticket-graph cares about.
function makeTask(
  id: string,
  dependencies: string[] = [],
  overrides: Partial<BacklogTaskRecord> = {}
): BacklogTaskRecord {
  return {
    acceptanceCriteria: [],
    dependencies,
    filePath: `/backlog/tasks/${id}.md`,
    id,
    modifiedFiles: [],
    references: [],
    status: "To Do",
    title: `Task ${id}`,
    ...overrides,
  };
}

// Sync helper — our tasks have no cycles so this always succeeds.
function buildGraph(tasks: BacklogTaskRecord[]) {
  return Effect.runSync(buildTicketGraphEffect(tasks));
}

describe("loopStateSchema", () => {
  it("accepts all five lifecycle values", () => {
    const values: LoopState[] = [
      "queued",
      "running",
      "merging",
      "passed",
      "blocked",
    ];
    for (const v of values) {
      expect(loopStateSchema.parse(v)).toBe(v);
    }
  });

  it("rejects an unknown status string", () => {
    expect(() => loopStateSchema.parse("unknown")).toThrow();
  });

  it("is the single source of truth — enum options are the full set", () => {
    // AC3: the exported enum options are exactly the five defined states; no extra
    // literal is silently recognised elsewhere.
    expect(loopStateSchema.options).toStrictEqual([
      "queued",
      "running",
      "merging",
      "passed",
      "blocked",
    ]);
  });
});

describe("serializeTicketGraph", () => {
  it("AC2: 3-node chain yields correct nodes/edges/batches/dangling", () => {
    // A -> B -> C (A must complete before B, B before C)
    const tasks = [makeTask("A"), makeTask("B", ["A"]), makeTask("C", ["B"])];
    const graph = buildGraph(tasks);
    const dto = Effect.runSync(serializeTicketGraph(graph));

    // nodes — all three present, no loopState defaults (queued)
    expect(dto.nodes).toHaveLength(3);
    const nodeIds = dto.nodes.map((n) => n.id).sort();
    expect(nodeIds).toStrictEqual(["A", "B", "C"]);
    for (const node of dto.nodes) {
      expect(node.loopState).toBe("queued");
    }

    // edges — A→B and B→C
    const edgePairs = dto.edges.map((e) => `${e.from}→${e.to}`).sort();
    expect(edgePairs).toStrictEqual(["A→B", "B→C"]);

    // batches — three sequential batches: [A], [B], [C]
    expect(dto.batches).toStrictEqual([["A"], ["B"], ["C"]]);

    // dangling — none
    expect(dto.dangling).toStrictEqual([]);
  });

  it("places two independent tasks in the same batch", () => {
    const tasks = [makeTask("X"), makeTask("Y")];
    const graph = buildGraph(tasks);
    const dto = Effect.runSync(serializeTicketGraph(graph));

    // Both tasks have no dependencies → one batch containing both (sorted)
    expect(dto.batches).toHaveLength(1);
    expect([...dto.batches[0]].sort()).toStrictEqual(["X", "Y"]);
  });

  it("surfaces dangling dependency strings", () => {
    // C depends on MISSING, which is not in the task list
    const tasks = [makeTask("C", ["MISSING"])];
    const graph = buildGraph(tasks);
    const dto = Effect.runSync(serializeTicketGraph(graph));

    expect(dto.dangling).toHaveLength(1);
    expect(dto.dangling[0]).toContain("MISSING");
  });

  it("wire DTO validates through ticketGraphDtoSchema", () => {
    const tasks = [makeTask("A"), makeTask("B", ["A"])];
    const graph = buildGraph(tasks);
    const dto = Effect.runSync(serializeTicketGraph(graph));
    expect(() => ticketGraphDtoSchema.parse(dto)).not.toThrow();
  });

  it("node fields include id, title, status, priority, loopState", () => {
    const task = makeTask("T1", [], {
      priority: "high",
      status: "In Progress",
    });
    const graph = buildGraph([task]);
    const dto = Effect.runSync(serializeTicketGraph(graph));

    const node = dto.nodes[0];
    expect(node).toMatchObject({
      id: "T1",
      loopState: "queued",
      priority: "high",
      status: "In Progress",
      title: "Task T1",
    });
  });
});
