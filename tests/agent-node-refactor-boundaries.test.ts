import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const AGENT_NODE_OWNER_FILES = [
  "src/runtime/agent-node/handoff-finalization.ts",
  "src/runtime/agent-node/model-selection.ts",
  "src/runtime/agent-node/output-finalization.ts",
  "src/runtime/agent-node/prompt-rendering.ts",
  "src/runtime/agent-node/session-execution.ts",
];
const AGENT_NODE_MAX_LINES = 1000;
const SUPPRESSION_MARKERS = [
  ["fallow", "ignore"].join("-"),
  ["biome", "ignore"].join("-"),
];

describe("PIPE-45.11 agent-node owner boundaries", () => {
  it("keeps agent-node.ts as the execution entrypoint", () => {
    const missingOwners = AGENT_NODE_OWNER_FILES.filter(
      (path) => !existsSync(join(ROOT, path))
    );
    const source = readFileSync(
      join(ROOT, "src/runtime/agent-node/agent-node.ts"),
      "utf8"
    );

    expect(missingOwners).toEqual([]);
    expect(source.split("\n").length).toBeLessThanOrEqual(AGENT_NODE_MAX_LINES);
    for (const marker of SUPPRESSION_MARKERS) {
      expect(source).not.toContain(marker);
    }
  });
});
