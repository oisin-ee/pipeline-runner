import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const JS_SUFFIX_RE = /\.js$/u;

const readPipelineFile = (path: string): string => {
  const distPath = join(import.meta.dirname, "..", "dist", path);
  if (existsSync(distPath)) {
    return readFileSync(distPath, "utf-8");
  }
  return readFileSync(
    join(import.meta.dirname, "..", "src", path.replace(JS_SUFFIX_RE, ".ts")),
    "utf-8"
  );
};

describe("scheduler and install command contracts", () => {
  it("keeps RED test-writing directly upstream of GREEN in the scheduler artifact", () => {
    const scheduleBaseline = readPipelineFile("schedule/baseline.js");
    const schedulePrompts = readPipelineFile("schedule/prompts.js");

    expect(scheduleBaseline).toContain('id: "green-implementation"');
    expect(scheduleBaseline).toContain('needs: ["red-tests"]');
    expect(schedulePrompts).toContain(
      "Do not add blocking builtin test, lint, typecheck, or fallow nodes between RED test-writing nodes and GREEN implementation nodes."
    );
    expect(scheduleBaseline).not.toContain('id: "mechanical-red-tests"');
    expect(scheduleBaseline).not.toContain('id: "mechanical-red-typecheck"');
    expect(scheduleBaseline).not.toContain('id: "mechanical-red-lint"');
    expect(scheduleBaseline).not.toContain('id: "mechanical-red-fallow"');
  });

  it("renders local orchestrator dispatch in the install command artifact", () => {
    const installCommands = readPipelineFile("install-commands/opencode.js");

    expect(installCommands).toContain("localOrchestratorDispatchBlock");
    expect(installCommands).toContain("localOrchestratorDispatchBlock(config)");
  });
});
