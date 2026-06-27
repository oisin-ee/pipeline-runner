import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const HOOK_OWNER_FILES = [
  "src/runtime/hooks/command-hook.ts",
  "src/runtime/hooks/context.ts",
  "src/runtime/hooks/events.ts",
  "src/runtime/hooks/execution.ts",
  "src/runtime/hooks/invocation.ts",
  "src/runtime/hooks/policy.ts",
  "src/runtime/hooks/results.ts",
  "src/runtime/hooks/types.ts",
];
const GATE_KIND_OWNER_FILES = [
  "src/runtime/gates/registry.ts",
  "src/runtime/gates/kinds/acceptance/acceptance.ts",
  "src/runtime/gates/kinds/artifact/artifact.ts",
  "src/runtime/gates/kinds/builtin/builtin.ts",
  "src/runtime/gates/kinds/changed-files/changed-files.ts",
  "src/runtime/gates/kinds/command/command.ts",
  "src/runtime/gates/kinds/json-schema/json-schema.ts",
  "src/runtime/gates/kinds/verdict/verdict.ts",
];
const HOOKS_ENTRYPOINT_MAX_LINES = 140;
const SUPPRESSION_MARKERS = [
  ["fallow", "ignore"].join("-"),
  ["biome", "ignore"].join("-"),
  ["@ts", "expect", "error"].join("-"),
  ["@ts", "ignore"].join("-"),
];

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("PIPE-45.12 hook and gate owner boundaries", () => {
  it("keeps hook dispatch thin while policies, results, events, and command IO have owners", () => {
    const missingOwners = HOOK_OWNER_FILES.filter(
      (path) => !existsSync(join(ROOT, path))
    );
    const hooksSource = source("src/runtime/hooks/hooks.ts");

    expect(missingOwners).toEqual([]);
    expect(hooksSource).toContain("dispatchHooks");
    expect(hooksSource.split("\n").length).toBeLessThanOrEqual(
      HOOKS_ENTRYPOINT_MAX_LINES
    );
    expect(hooksSource).not.toContain("CommandExecutor");
    expect(hooksSource).not.toContain("PIPELINE_HOOK_INPUT");
    expect(hooksSource).not.toContain("command hooks are disabled");
    expect(hooksSource).not.toContain("runtime.hook.started");
    expect(hooksSource).not.toContain("parseHookResult");
    for (const marker of SUPPRESSION_MARKERS) {
      expect(hooksSource).not.toContain(marker);
    }
  });

  it("keeps gate variation behind kind modules and JSON-source parsing on the public gate surface", () => {
    const missingOwners = GATE_KIND_OWNER_FILES.filter(
      (path) => !existsSync(join(ROOT, path))
    );
    const registrySource = source("src/runtime/gates/registry.ts");
    const gatesSource = source("src/runtime/gates/gates.ts");

    expect(missingOwners).toEqual([]);
    expect(registrySource).toContain("Record<GateKind, GateEvaluator>");
    expect(registrySource).toContain("gateRegistry");
    expect(gatesSource).toContain("parseGateJson");
    for (const marker of SUPPRESSION_MARKERS) {
      expect(registrySource).not.toContain(marker);
      expect(gatesSource).not.toContain(marker);
    }
  });
});
