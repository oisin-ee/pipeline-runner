import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE_SUPPRESSION_MARKER = ["fallow", "ignore", "file"].join("-");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("PIPE-45.7 run-control ownership boundaries", () => {
  it("keeps run-control command registration separate from command behavior", () => {
    const commands = source("src/run-control/commands.ts");

    expect(commands).not.toContain(FILE_SUPPRESSION_MARKER);
    expect(commands).not.toContain("function printRunsEffect");
    expect(commands).not.toContain("function printStatusEffect");
    expect(commands).not.toContain("function readArtifactsEffect");
    expect(commands.split("\n").length).toBeLessThanOrEqual(180);
  });

  it("keeps filesystem store ownership visible without file-level suppressions", () => {
    expect(source("src/run-control/store.ts")).not.toContain(
      FILE_SUPPRESSION_MARKER
    );
  });
});
