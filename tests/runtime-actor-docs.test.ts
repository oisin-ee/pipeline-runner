import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gateStateNames,
  hookStateNames,
  nodeStateNames,
  workflowStateNames,
} from "../src/runtime-machines/contracts.js";

describe("runtime actor documentation", () => {
  it("keeps documented state taxonomy aligned with runtime contracts", () => {
    const doc = readFileSync(
      join(process.cwd(), "docs/xstate-runtime-actor-model.md"),
      "utf8"
    );

    expect(documentedStates(doc, "Workflow")).toEqual(workflowStateNames);
    expect(documentedStates(doc, "Node")).toEqual(nodeStateNames);
    expect(documentedStates(doc, "Hook")).toEqual(hookStateNames);
    expect(documentedStates(doc, "Gate")).toEqual(gateStateNames);
  });
});

function documentedStates(doc: string, label: string): string[] {
  const line = doc
    .split("\n")
    .find((candidate) => candidate.startsWith(`${label} states:`));
  if (!line) {
    throw new Error(`Missing ${label} states line`);
  }
  return Array.from(line.matchAll(/`([^`]+)`/g), (match) => match[1]);
}
