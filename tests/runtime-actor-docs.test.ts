import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED_WORKFLOW_STATES = [
  "planning",
  "startingHooks",
  "checkingStartHooks",
  "scheduling",
  "runningBatch",
  "evaluatingBatch",
  "failureHooks",
  "failureCompleteHooks",
  "successHooks",
  "completeHooks",
  "checkingCompleteHooks",
  "cancelling",
  "passed",
  "failed",
  "cancelled",
] as const;

const EXPECTED_NODE_STATES = [
  "pending",
  "ready",
  "startingHooks",
  "snapshotBefore",
  "runnerStarting",
  "runnerRunning",
  "runnerFinished",
  "outputRecording",
  "snapshotAfter",
  "gatesStarting",
  "gatesRunning",
  "gatesFinished",
  "successHooks",
  "retrying",
  "passed",
  "failed",
  "cancelled",
  "skipped",
] as const;

const EXPECTED_HOOK_STATES = [
  "queued",
  "running",
  "passed",
  "failed",
  "timedOut",
  "skipped",
] as const;

const EXPECTED_GATE_STATES = [
  "pending",
  "running",
  "passed",
  "failed",
  "timedOut",
  "cancelled",
] as const;
const XSTATE_BRAND_RE = /\bXState\b|\bxstate\b/;

describe("runtime actor documentation", () => {
  it("uses the non-XState runtime actor model document", () => {
    const oldDocPath = join(
      process.cwd(),
      "docs/xstate-runtime-actor-model.md"
    );
    const docPath = join(process.cwd(), "docs/runtime-actor-model.md");

    expect(existsSync(oldDocPath)).toBe(false);
    expect(existsSync(docPath)).toBe(true);
  });

  it("keeps documented state taxonomy without importing runtime-machine contracts", () => {
    const doc = readFileSync(
      join(process.cwd(), "docs/runtime-actor-model.md"),
      "utf8"
    );

    expect(doc).not.toMatch(XSTATE_BRAND_RE);
    expect(documentedStates(doc, "Workflow")).toEqual([
      ...EXPECTED_WORKFLOW_STATES,
    ]);
    expect(documentedStates(doc, "Node")).toEqual([...EXPECTED_NODE_STATES]);
    expect(documentedStates(doc, "Hook")).toEqual([...EXPECTED_HOOK_STATES]);
    expect(documentedStates(doc, "Gate")).toEqual([...EXPECTED_GATE_STATES]);
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
