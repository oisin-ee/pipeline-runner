import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { BacklogService } from "../src/runtime/services/backlog-service";
import type { TicketPlan } from "../src/tickets/ticket-plan";

interface BacklogCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

const PLAN: TicketPlan = {
  epic: {
    acceptance_criteria: [{ evidence: "Apply test creates epic first.", text: "Epic is created." }],
    description: "Create the epic parent.",
    key: "epic",
    likely_files: [],
    plan: "Create the epic before children.",
    priority: "high",
    references: [],
    title: "Epic: Apply ticket plan",
  },
  tickets: [
    {
      acceptance_criteria: [
        {
          evidence: "Apply test parses the schema id.",
          text: "Schema child is created.",
        },
      ],
      depends_on: [],
      description: "Create schema child.",
      key: "schema",
      likely_files: ["src/tickets/ticket-plan.ts"],
      plan: "Create schema child first.",
      priority: "high",
      references: [],
      title: "Create schema child",
    },
    {
      acceptance_criteria: [
        {
          evidence: "Apply test passes the real schema id as --dep.",
          text: "Dependency id is resolved.",
        },
      ],
      depends_on: ["schema"],
      description: "Create render child.",
      key: "render",
      likely_files: ["src/tickets/ticket-plan-render.ts"],
      plan: "Create render child after schema.",
      priority: "medium",
      references: ["src/tickets/ticket-plan.ts"],
      title: "Create render child",
    },
  ],
};

const backlogLayer = (outputs: readonly string[], calls: BacklogCall[]) => {
  let index = 0;
  return Layer.succeed(BacklogService, {
    run: (args, cwd) =>
      Effect.sync(() => {
        calls.push({ args, cwd });
        const output = outputs[index];
        index += 1;
        return output ?? "Task PIPE-999 - Unexpected";
      }),
  });
};

describe("apply ticket plan", () => {
  it("creates an epic parent before children and resolves local dependency keys", async () => {
    const { applyTicketPlanEffect } = await import("../src/tickets/apply-ticket-plan");
    const calls: BacklogCall[] = [];

    const result = await Effect.runPromise(
      Effect.provide(
        applyTicketPlanEffect(PLAN, "/repo", {}),
        backlogLayer(
          [
            "Task PIPE-100 - Epic: Apply ticket plan",
            "Task PIPE-100.1 - Create schema child",
            "Task PIPE-100.2 - Create render child",
          ],
          calls,
        ),
      ),
    );

    expect(result).toEqual({
      createdIds: ["PIPE-100", "PIPE-100.1", "PIPE-100.2"],
      parentId: "PIPE-100",
      taskIdsByKey: { render: "PIPE-100.2", schema: "PIPE-100.1" },
    });
    expect(calls.map((call) => call.args)).toEqual([
      [
        "task",
        "create",
        "Epic: Apply ticket plan",
        "--description",
        "Create the epic parent.",
        "--priority",
        "high",
        "--ac",
        "Epic is created.; evidence: Apply test creates epic first.",
        "--plan",
        "Create the epic before children.",
        "--plain",
      ],
      [
        "task",
        "create",
        "Create schema child",
        "--parent",
        "PIPE-100",
        "--description",
        "Create schema child.",
        "--priority",
        "high",
        "--ac",
        "Schema child is created.; evidence: Apply test parses the schema id.",
        "--plan",
        "Create schema child first.",
        "--modified-file",
        "src/tickets/ticket-plan.ts",
        "--plain",
      ],
      [
        "task",
        "create",
        "Create render child",
        "--parent",
        "PIPE-100",
        "--description",
        "Create render child.",
        "--priority",
        "medium",
        "--dep",
        "PIPE-100.1",
        "--ac",
        "Dependency id is resolved.; evidence: Apply test passes the real schema id as --dep.",
        "--plan",
        "Create render child after schema.",
        "--ref",
        "src/tickets/ticket-plan.ts",
        "--modified-file",
        "src/tickets/ticket-plan-render.ts",
        "--plain",
      ],
    ]);
  });

  it("uses an existing parent when provided and does not create a new epic", async () => {
    const { applyTicketPlanEffect } = await import("../src/tickets/apply-ticket-plan");
    const calls: BacklogCall[] = [];

    const result = await Effect.runPromise(
      Effect.provide(
        applyTicketPlanEffect(PLAN, "/repo", { parentId: "PIPE-84" }),
        backlogLayer(["Task PIPE-84.10 - Create schema child", "Task PIPE-84.11 - Create render child"], calls),
      ),
    );

    expect(result.parentId).toBe("PIPE-84");
    expect(result.createdIds).toEqual(["PIPE-84.10", "PIPE-84.11"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("--parent");
    expect(calls[0]?.args).toContain("PIPE-84");
    expect(calls[0]?.args).not.toContain("Epic: Apply ticket plan");
  });

  it("reports created ids, failed command context, and blocker when id parsing fails", async () => {
    const { applyTicketPlanEffect } = await import("../src/tickets/apply-ticket-plan");
    const calls: BacklogCall[] = [];

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        applyTicketPlanEffect(PLAN, "/repo", {}),
        backlogLayer(
          ["Task PIPE-100 - Epic: Apply ticket plan", "Backlog created something but omitted the task id"],
          calls,
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("created ids: PIPE-100");
    expect(String(exit)).toContain("failed command: backlog task create");
    expect(String(exit)).toContain("could not parse created task id");
  });
});
