import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { BacklogTaskRecord } from "../src/tickets/backlog-task-store";
import { buildTicketGraphEffect } from "../src/tickets/ticket-graph";
import type { TicketGraph } from "../src/tickets/ticket-graph";

const task = (id: string, input: Partial<BacklogTaskRecord> = {}): BacklogTaskRecord => ({
  acceptanceCriteria: [],
  dependencies: [],
  filePath: `/tmp/${id}.md`,
  id,
  modifiedFiles: [],
  ordinal: 0,
  priority: "medium",
  references: [],
  status: "To Do",
  title: id,
  ...input,
});

const graph = async (tasks: readonly BacklogTaskRecord[]): Promise<TicketGraph> =>
  await Effect.runPromise(buildTicketGraphEffect(tasks));

describe("ticket ready selection", () => {
  it("requires To Do status and Done dependencies", async () => {
    const { selectReadyTickets } = await import("../src/tickets/ticket-selection");
    const ticketGraph = await graph([
      task("PIPE-1", { status: "Done" }),
      task("PIPE-2", { dependencies: ["PIPE-1"] }),
      task("PIPE-3", { dependencies: ["PIPE-2"] }),
      task("PIPE-4", { status: "In Progress" }),
    ]);

    expect(selectReadyTickets(ticketGraph).map(({ id }) => id)).toEqual(["PIPE-2"]);
  });

  it("excludes parent epics with incomplete children unless explicitly included", async () => {
    const { selectReadyTickets } = await import("../src/tickets/ticket-selection");
    const ticketGraph = await graph([
      task("PIPE-84", { priority: "high" }),
      task("PIPE-84.1", { parentTaskId: "PIPE-84" }),
    ]);

    expect(selectReadyTickets(ticketGraph).map(({ id }) => id)).toEqual(["PIPE-84.1"]);
    expect(selectReadyTickets(ticketGraph, { includeParents: true }).map(({ id }) => id)).toEqual([
      "PIPE-84",
      "PIPE-84.1",
    ]);
  });

  it("orders by priority, ordinal, then natural Backlog id by default", async () => {
    const { selectReadyTickets } = await import("../src/tickets/ticket-selection");
    const ticketGraph = await graph([
      task("PIPE-10", { ordinal: 2, priority: "medium" }),
      task("PIPE-2", { ordinal: 2, priority: "medium" }),
      task("PIPE-3", { ordinal: 1, priority: "medium" }),
      task("PIPE-4", { ordinal: 100, priority: "high" }),
      task("PIPE-5", { ordinal: 0, priority: "low" }),
    ]);

    expect(selectReadyTickets(ticketGraph).map(({ id }) => id)).toEqual([
      "PIPE-4",
      "PIPE-3",
      "PIPE-2",
      "PIPE-10",
      "PIPE-5",
    ]);
  });

  it("supports bfs and dfs strategies with natural sibling tie-breaking", async () => {
    const { selectReadyTickets } = await import("../src/tickets/ticket-selection");
    const ticketGraph = await graph([
      task("PIPE-84", { status: "Done" }),
      task("PIPE-84.1", { parentTaskId: "PIPE-84" }),
      task("PIPE-84.2", { parentTaskId: "PIPE-84" }),
      task("PIPE-84.1.1", { parentTaskId: "PIPE-84.1" }),
    ]);

    expect(
      selectReadyTickets(ticketGraph, {
        includeParents: true,
        rootId: "PIPE-84",
        strategy: "bfs",
      }).map(({ id }) => id),
    ).toEqual(["PIPE-84.1", "PIPE-84.2", "PIPE-84.1.1"]);
    expect(
      selectReadyTickets(ticketGraph, {
        includeParents: true,
        rootId: "PIPE-84",
        strategy: "dfs",
      }).map(({ id }) => id),
    ).toEqual(["PIPE-84.1", "PIPE-84.1.1", "PIPE-84.2"]);
  });

  it("is read-only and repeatable", async () => {
    const { selectReadyTickets } = await import("../src/tickets/ticket-selection");
    const ticketGraph = await graph([task("PIPE-1")]);
    const before = ticketGraph.tasksById.get("PIPE-1")?.status;

    expect(selectReadyTickets(ticketGraph)).toEqual(selectReadyTickets(ticketGraph));
    expect(ticketGraph.tasksById.get("PIPE-1")?.status).toBe(before);
  });
});
