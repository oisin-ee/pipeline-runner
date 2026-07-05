import { describe, expect, it, vi } from "vitest";

import {
  baseGateRuntimeFields,
  gateNodeStateStore,
} from "../../../../../tests/gate-test-context";
import { parsePipelineConfigParts } from "../../../../config/load";
import { compileWorkflowPlan } from "../../../../planning/compile";
import type { BuiltinGateSpec, RuntimeContext } from "../../../contracts";

// Mock executeBuiltin so no actual builtins (tests, linting) are invoked.
vi.mock("../../../builtins", () => ({
  executeBuiltin: vi.fn(),
}));

import { executeBuiltin } from "../../../builtins";
import { evaluateBuiltinGate } from "./builtin";

const testContext = (): RuntimeContext => {
  const config = parsePipelineConfigParts(
    {
      pipeline:
        "version: 1\ndefault_workflow: smoke\nworkflows:\n  smoke:\n    nodes:\n      - id: check\n        kind: command\n        command: [node, -e, '0']\n",
      profiles: "version: 1\nprofiles: {}\n",
      runners:
        "version: 1\nrunners:\n  local:\n    type: command\n    command: node\n    capabilities: { native_subagents: false }\n",
    },
    "/tmp/builtin-gate-test"
  );
  return {
    ...baseGateRuntimeFields(),
    config,
    nodeStateStore: gateNodeStateStore("node", []),
    plan: compileWorkflowPlan(config, "smoke"),
    runId: "test-run",
    task: "builtin gate unit test",
    workflowId: "smoke",
    worktreePath: process.cwd(),
  };
};

const gate: BuiltinGateSpec = { builtin: "test", kind: "builtin" };
const BUILTIN_FAILED_RE = /builtin 'test' failed/u;

describe("evaluateBuiltinGate", () => {
  it("passes when builtin exits 0", async () => {
    vi.mocked(executeBuiltin).mockResolvedValueOnce({
      evidence: ["ok"],
      exitCode: 0,
      output: "",
    });
    const result = await evaluateBuiltinGate(
      gate,
      "builtin:node",
      "node",
      testContext()
    );
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("builtin");
    expect(result.reason).toBeUndefined();
  });

  it("fails when builtin exits non-zero", async () => {
    vi.mocked(executeBuiltin).mockResolvedValueOnce({
      evidence: ["fail"],
      exitCode: 1,
      output: "",
    });
    const result = await evaluateBuiltinGate(
      gate,
      "builtin:node",
      "node",
      testContext()
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(BUILTIN_FAILED_RE);
  });
});
