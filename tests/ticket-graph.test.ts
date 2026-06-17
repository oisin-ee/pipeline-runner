import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { BacklogTaskRecord } from "../src/tickets/backlog-task-store";

function task(
  id: string,
  input: Partial<BacklogTaskRecord> = {}
): BacklogTaskRecord {
  return {
    acceptanceCriteria: [],
    dependencies: [],
    filePath: `/tmp/${id}.md`,
    id,
    modifiedFiles: [],
    references: [],
    status: "To Do",
    title: id,
    ...input,
  };
}

describe("ticket dependency graph", () => {
  it("models dependency edges and parent-child containment", async () => {
    const { buildTicketGraphEffect } = await import(
      "../src/tickets/ticket-graph"
    );

    const graph = await Effect.runPromise(
      buildTicketGraphEffect([
        task("PIPE-84"),
        task("PIPE-84.1", { parentTaskId: "PIPE-84" }),
        task("PIPE-84.2", {
          dependencies: ["PIPE-84.1"],
          parentTaskId: "PIPE-84",
        }),
      ])
    );

    expect(graph.dependencyGraph.hasEdge("PIPE-84.1", "PIPE-84.2")).toBe(true);
    expect(
      graph.childrenByParentId.get("PIPE-84")?.map(({ id }) => id)
    ).toEqual(["PIPE-84.1", "PIPE-84.2"]);
  });

  it("keeps missing dependencies and cycles in the Effect error channel", async () => {
    const { buildTicketGraphEffect } = await import(
      "../src/tickets/ticket-graph"
    );

    const missingExit = await Effect.runPromiseExit(
      buildTicketGraphEffect([task("PIPE-1", { dependencies: ["PIPE-404"] })])
    );
    if (!Exit.isFailure(missingExit)) {
      throw new Error("Expected missing dependency graph to fail");
    }
    expect(String(missingExit.cause)).toContain("PIPE-1");
    expect(String(missingExit.cause)).toContain("PIPE-404");

    const cycleExit = await Effect.runPromiseExit(
      buildTicketGraphEffect([
        task("PIPE-1", { dependencies: ["PIPE-2"] }),
        task("PIPE-2", { dependencies: ["PIPE-1"] }),
      ])
    );
    if (!Exit.isFailure(cycleExit)) {
      throw new Error("Expected cyclic graph to fail");
    }
    expect(String(cycleExit.cause)).toContain("cycle");
    expect(String(cycleExit.cause)).toContain("PIPE-1");
    expect(String(cycleExit.cause)).toContain("PIPE-2");
  });

  it("computes stable dependency execution batches", async () => {
    const { buildTicketGraphEffect, sequenceTicketBatchesEffect } =
      await import("../src/tickets/ticket-graph");
    const graph = await Effect.runPromise(
      buildTicketGraphEffect([
        task("PIPE-84.1"),
        task("PIPE-84.2", { dependencies: ["PIPE-84.1"] }),
        task("PIPE-84.3", { dependencies: ["PIPE-84.1"] }),
        task("PIPE-84.4", { dependencies: ["PIPE-84.2", "PIPE-84.3"] }),
      ])
    );

    await expect(
      Effect.runPromise(sequenceTicketBatchesEffect(graph))
    ).resolves.toEqual([
      ["PIPE-84.1"],
      ["PIPE-84.2", "PIPE-84.3"],
      ["PIPE-84.4"],
    ]);
  });
});
