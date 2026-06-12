import { describe, expect, it } from "vitest";
import type { RuntimeContext } from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { inheritedOutputSections, renderTaskContext } from "./agent-node";

describe("runtime agent node", () => {
  it("renders canonical task context with acceptance criteria", () => {
    expect(
      renderTaskContext({
        acceptanceCriteria: [{ id: "A", text: "Do it" }],
        description: "Description",
        id: "PIPE-1",
        title: "Title",
      })
    ).toBe(
      [
        "Canonical task context:",
        "ID: PIPE-1",
        "Title: Title",
        "Description: Description",
        "Acceptance criteria:",
        "- A: Do it",
      ].join("\n")
    );
  });

  it("renders inherited outputs that are not direct dependencies", () => {
    const context = {
      nodeStateStore: new NodeStateStore({
        inheritedOutputNodeIds: new Set(["setup", "direct"]),
        lastOutputByNode: new Map([
          ["setup", "setup output"],
          ["direct", "direct output"],
        ]),
      }),
    } satisfies Pick<RuntimeContext, "nodeStateStore">;

    expect(
      inheritedOutputSections(
        {
          children: [],
          dependents: [],
          id: "agent",
          index: 0,
          kind: "agent",
          needs: ["direct"],
          profile: "a",
        },
        context
      )
    ).toEqual(["Inherited dependency outputs:", "## setup\nsetup output", ""]);
  });
});
