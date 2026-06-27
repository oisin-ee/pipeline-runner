import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const RUNTIME_OWNER_FILES = [
  "src/runtime/config-error.ts",
  "src/runtime/journal-acquisition.ts",
  "src/runtime/node-execution.ts",
  "src/runtime/runtime-results.ts",
  "src/runtime/scheduled-dependencies.ts",
  "src/runtime/workflow-execution.ts",
];
const PIPELINE_RUNTIME_MAX_LINES = 1000;
const FILE_SUPPRESSION_MARKER = ["fallow", "ignore", "file"].join("-");
const PIPELINE_RUNTIME_INTERNAL_IMPORTS = [
  "./runtime/agent-node",
  "./runtime/builtins",
  "./runtime/command-executor",
  "./runtime/durable-store/postgres/postgres-store",
  "./runtime/gates",
  "./runtime/hooks",
  "./runtime/local-scheduler",
  "./runtime/parallel-node",
];

describe("PIPE-45.10 runtime owner boundaries", () => {
  it("keeps src/pipeline-runtime.ts as the public runtime entrypoint", () => {
    const missingOwners = RUNTIME_OWNER_FILES.filter(
      (path) => !existsSync(join(ROOT, path))
    );
    const runtimeText = readFileSync(
      join(ROOT, "src/pipeline-runtime.ts"),
      "utf8"
    );

    expect(missingOwners).toEqual([]);
    expect(runtimeText.split("\n").length).toBeLessThanOrEqual(
      PIPELINE_RUNTIME_MAX_LINES
    );
    expect(runtimeText).not.toContain(FILE_SUPPRESSION_MARKER);
    for (const internalImport of PIPELINE_RUNTIME_INTERNAL_IMPORTS) {
      expect(runtimeText).not.toContain(internalImport);
    }
  });
});
