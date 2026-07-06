import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { baseGateRuntimeFields, gateNodeStateStore } from "../../../tests/gate-test-context";
import { parsePipelineConfigParts } from "../../config/load";
import { compileWorkflowPlan } from "../../planning/compile";
import type { ChangedFilesGateSpec, GateSpec, RuntimeContext } from "../contracts";
import type { GateEvaluationInput, GateKind } from "./contract";
import { evaluateChangedFilesGate } from "./kinds/changed-files/changed-files";
import { evaluateGate, gateRegistry } from "./registry";

const EXPECTED_KINDS: GateKind[] = [
  "acceptance",
  "artifact",
  "builtin",
  "changed_files",
  "command",
  "json_schema",
  "verdict",
];

const runtimeContext = (): RuntimeContext => {
  const config = parsePipelineConfigParts(
    {
      pipeline:
        'version: 1\ndefault_workflow: smoke\nworkflows:\n  smoke:\n    nodes:\n      - id: check\n        kind: command\n        command: [node, -e, "0"]\n',
      profiles: "version: 1\nprofiles: {}\n",
      runners:
        "version: 1\nrunners:\n  local:\n    type: command\n    command: node\n    capabilities: { native_subagents: false }\n",
    },
    "/tmp/registry-dispatch-test",
  );
  return {
    ...baseGateRuntimeFields(),
    config,
    nodeStateStore: gateNodeStateStore("node-a", ["README.md"]),
    plan: compileWorkflowPlan(config, "smoke"),
    runId: "run-registry",
    task: "registry dispatch test",
    workflowId: "smoke",
    worktreePath: process.cwd(),
  };
};

const dispatchInput = (gate: GateSpec): GateEvaluationInput => ({
  attempt: { evidence: [], exitCode: 0, output: "" },
  context: runtimeContext(),
  executor: {
    execute: () => Effect.succeed({ evidence: [], exitCode: 0, output: "" }),
  },
  gate,
  gateId: gate.id ?? `${gate.kind}:node-a`,
  nodeId: "node-a",
});

const denyMarkdownGate: ChangedFilesGateSpec = {
  changed_files: { deny: ["**/*.md"] },
  id: "changed:node-a",
  kind: "changed_files",
};

describe("gate registry", () => {
  it("registers exactly one evaluator for every declared gate kind", () => {
    expect(Object.keys(gateRegistry).toSorted()).toEqual([...EXPECTED_KINDS].toSorted());
    for (const kind of EXPECTED_KINDS) {
      expect(typeof gateRegistry[kind]).toBe("function");
    }
  });

  it("dispatches a gate to the evaluator registered under its kind", async () => {
    const input = dispatchInput(denyMarkdownGate);

    const dispatched = await evaluateGate(input);
    const direct = evaluateChangedFilesGate(denyMarkdownGate, input.gateId, input.nodeId, input.context);

    expect(dispatched).toEqual(direct);
    expect(dispatched).toEqual({
      evidence: ["denied changes: README.md"],
      gateId: "changed:node-a",
      kind: "changed_files",
      nodeId: "node-a",
      passed: false,
      reason: "changed-file policy failed",
    });
  });

  it("binds each registry slot to its own kind and fails loud on a foreign gate", async () => {
    const input = dispatchInput(denyMarkdownGate);

    for (const kind of EXPECTED_KINDS) {
      if (kind === "changed_files") {
        continue;
      }
      await expect(gateRegistry[kind](input)).rejects.toThrow(
        new RegExp(`gate registry mismatch: handler '${kind}'`, "u"),
      );
    }
  });
});
