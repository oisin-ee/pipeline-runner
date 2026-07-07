import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

const VALID_PLAN = {
  epic: {
    acceptance_criteria: [
      {
        evidence: "Focused CLI tests assert the dry-run output.",
        text: "Dry-run renders Backlog commands.",
      },
    ],
    description: "Create the ticket orchestration epic.",
    key: "epic",
    likely_files: ["src/commands/ticket-command.ts"],
    plan: "Create tickets without mutating Backlog during dry-run.",
    priority: "high",
    references: ["defaults/profiles.yaml"],
    title: "Epic: Add ticket orchestration",
  },
  tickets: [
    {
      acceptance_criteria: [
        {
          evidence: "Schema tests reject invalid local references.",
          text: "Ticket plan schema validates local dependencies.",
        },
      ],
      depends_on: [],
      description: "Add the ticket-plan schema.",
      key: "schema",
      likely_files: ["src/tickets/ticket-plan.ts"],
      plan: "Define the Effect Schema parser.",
      priority: "high",
      references: ["src/tickets/ticket-selection.ts"],
      title: "Build ticket-plan schema",
    },
    {
      acceptance_criteria: [
        {
          evidence: "Dry-run renderer snapshot includes --dep schema.",
          text: "Dry-run preserves local dependency keys.",
        },
      ],
      depends_on: ["schema"],
      description: "Render the Backlog commands.",
      key: "render",
      likely_files: ["src/tickets/ticket-plan-render.ts"],
      plan: "Render deterministic Backlog CLI commands.",
      priority: "medium",
      references: [],
      title: "Render ticket-plan commands",
    },
  ],
};

describe("ticket plan contract", () => {
  it("parses structured ticket plans and renders deterministic dry-run commands", async () => {
    const { parseTicketPlanEffect } =
      await import("../src/tickets/ticket-plan");
    const { renderTicketPlanDryRun } =
      await import("../src/tickets/ticket-plan-render");

    const plan = await Effect.runPromise(
      parseTicketPlanEffect(JSON.stringify(VALID_PLAN))
    );

    expect(plan.tickets.map((ticket) => ticket.key)).toEqual([
      "schema",
      "render",
    ]);
    expect(renderTicketPlanDryRun(plan)).toMatchInlineSnapshot(`
      "# Dry run: no Backlog files were written.
      backlog task create 'Epic: Add ticket orchestration' --description 'Create the ticket orchestration epic.' --priority high --ac 'Dry-run renders Backlog commands.; evidence: Focused CLI tests assert the dry-run output.' --plan 'Create tickets without mutating Backlog during dry-run.' --ref defaults/profiles.yaml --modified-file src/commands/ticket-command.ts --plain
      backlog task create 'Build ticket-plan schema' --parent epic --description 'Add the ticket-plan schema.' --priority high --ac 'Ticket plan schema validates local dependencies.; evidence: Schema tests reject invalid local references.' --plan 'Define the Effect Schema parser.' --ref src/tickets/ticket-selection.ts --modified-file src/tickets/ticket-plan.ts --plain
      backlog task create 'Render ticket-plan commands' --parent epic --description 'Render the Backlog commands.' --priority medium --dep schema --ac 'Dry-run preserves local dependency keys.; evidence: Dry-run renderer snapshot includes --dep schema.' --plan 'Render deterministic Backlog CLI commands.' --modified-file src/tickets/ticket-plan-render.ts --plain"
    `);
  });

  it("rejects missing acceptance evidence and unknown local dependency keys", async () => {
    const { parseTicketPlanEffect } =
      await import("../src/tickets/ticket-plan");

    const missingEvidence = await Effect.runPromiseExit(
      parseTicketPlanEffect(
        JSON.stringify({
          tickets: [
            {
              acceptance_criteria: [{ text: "Missing evidence." }],
              description: "Invalid ticket.",
              key: "invalid",
              plan: "Reject this plan.",
              title: "Invalid ticket",
            },
          ],
        })
      )
    );
    expect(Exit.isFailure(missingEvidence)).toBe(true);
    expect(String(missingEvidence)).toContain("acceptance_criteria.0.evidence");

    const unknownDependency = await Effect.runPromiseExit(
      parseTicketPlanEffect(
        JSON.stringify({
          tickets: [
            {
              acceptance_criteria: [
                { evidence: "Focused test.", text: "Has evidence." },
              ],
              depends_on: ["missing"],
              description: "Invalid ticket.",
              key: "invalid",
              plan: "Reject this plan.",
              title: "Invalid ticket",
            },
          ],
        })
      )
    );
    expect(Exit.isFailure(unknownDependency)).toBe(true);
    expect(String(unknownDependency)).toContain(
      "unknown dependency key 'missing'"
    );
  });
});
