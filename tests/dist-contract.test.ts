import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readDistFile = (path: string): string =>
  readFileSync(join(import.meta.dirname, "..", "dist", path), "utf8");

describe("published dist contracts", () => {
  it("keeps RED test-writing directly upstream of GREEN in the packaged scheduler", () => {
    const schedulePlanner = readDistFile("schedule-planner.js");

    expect(schedulePlanner).toContain('id: "green-implementation"');
    expect(schedulePlanner).toContain('needs: ["red-tests"]');
    expect(schedulePlanner).toContain(
      "Do not add blocking builtin test, lint, typecheck, or fallow nodes between RED test-writing nodes and GREEN implementation nodes."
    );
    expect(schedulePlanner).not.toContain('id: "mechanical-red-tests"');
    expect(schedulePlanner).not.toContain('id: "mechanical-red-typecheck"');
    expect(schedulePlanner).not.toContain('id: "mechanical-red-lint"');
    expect(schedulePlanner).not.toContain('id: "mechanical-red-fallow"');
  });

  it("renders scheduled entrypoint dispatch in the packaged install commands", () => {
    const installCommands = readDistFile("install-commands.js");

    expect(installCommands).toContain(
      "function orchestratorEntrypointDispatchBlock"
    );
    expect(installCommands).toContain(
      'orchestratorEntrypointDispatchBlock("opencode", config)'
    );
  });
});
