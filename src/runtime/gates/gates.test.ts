import { describe, expect, it } from "vitest";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import type { RuntimeObservabilityEvent } from "../actor-ids";
import type {
  AcceptanceCriterion,
  ChangedFilesGateSpec,
  PipelineRuntimeEvent,
  RuntimeContext,
} from "../contracts";
import { NodeStateStore } from "../node-state-store";
import {
  acceptanceCoverageEvidence,
  evaluateChangedFilesGate,
  evaluateNodeGates,
} from "./gates";

function directGateRuntimeContext(
  node: PlannedWorkflowNode,
  observability: RuntimeObservabilityEvent[],
  reporterEvents: PipelineRuntimeEvent[]
): RuntimeContext {
  return {
    agentInvocations: [],
    config: {
      default_workflow: "direct-gates",
      hooks: { functions: {}, on: {} },
      profiles: {},
      runners: {},
      version: 1,
      workflows: { "direct-gates": { nodes: [] } },
    } as unknown as RuntimeContext["config"],
    executor: async () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: [],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
    nodeStateStore: new NodeStateStore({
      nodeSnapshots: new Map([
        [
          node.id,
          {
            files: new Set(["README.md"]),
            fingerprints: new Map(),
          },
        ],
      ]),
    }),
    observability: (event) => observability.push(event),
    plan: {
      execution: { failFast: true },
      graph: { node: () => node },
      parallelBatches: [[node]],
      topologicalOrder: [node],
      workflowId: "direct-gates",
    } as unknown as RuntimeContext["plan"],
    reporter: (event) => reporterEvents.push(event),
    runId: "run-direct",
    task: "exercise direct gate evaluation",
    workflowId: "direct-gates",
    worktreePath: process.cwd(),
  };
}

describe("runtime gates", () => {
  it("reports missing, duplicate, extra, failing, and unevidenced acceptance coverage", () => {
    const expected: AcceptanceCriterion[] = [
      { id: "A", text: "Alpha" },
      { id: "B", text: "Beta" },
    ];

    expect(
      acceptanceCoverageEvidence(expected, [
        { evidence: ["ok"], id: "A", verdict: "PASS" },
        { evidence: ["again"], id: "A", verdict: "PASS" },
        { evidence: [], id: "C", verdict: "PASS" },
        { evidence: ["no"], id: "B", verdict: "FAIL" },
        { verdict: "PASS" },
      ])
    ).toEqual([
      "extra acceptance criterion 'C'",
      "acceptance criterion 'C' has no evidence",
      "acceptance criterion 'B' verdict 'FAIL'",
      "acceptance entry missing id",
      "duplicate acceptance criterion 'A'",
    ]);
  });

  it("evaluates changed-file allow, deny, required, and untracked policies", () => {
    const context = {
      nodeStateStore: new NodeStateStore({
        nodeSnapshots: new Map([
          [
            "node-a",
            {
              files: new Set(["src/app.ts", "README.md", "?? scratch.txt"]),
              fingerprints: new Map(),
            },
          ],
        ]),
      }),
    } satisfies Pick<RuntimeContext, "nodeStateStore">;
    const gate: ChangedFilesGateSpec = {
      changed_files: {
        allow: ["src/**"],
        deny: ["**/*.md"],
        include_untracked: false,
        require_any: ["src/**"],
      },
      kind: "changed_files",
    };

    expect(
      evaluateChangedFilesGate(gate, "changed:node-a", "node-a", context)
    ).toEqual({
      evidence: [
        "denied changes: README.md",
        "changes outside allow list: README.md",
      ],
      gateId: "changed:node-a",
      kind: "changed_files",
      nodeId: "node-a",
      passed: false,
      reason: "changed-file policy failed",
    });
  });

  it("evaluates gates directly while preserving result and observability contracts", async () => {
    const node: PlannedWorkflowNode = {
      dependents: [],
      gates: [
        {
          changed_files: { deny: ["**/*.md"], require_any: ["src/**"] },
          id: "changed-policy",
          kind: "changed_files",
        },
      ],
      id: "node-a",
      index: 0,
      kind: "agent",
      needs: [],
    };
    const observability: RuntimeObservabilityEvent[] = [];
    const reporterEvents: PipelineRuntimeEvent[] = [];
    const context = directGateRuntimeContext(
      node,
      observability,
      reporterEvents
    );

    const results = await evaluateNodeGates(node, context, {
      evidence: [],
      exitCode: 0,
      output: "",
    });

    expect(results).toEqual([
      {
        evidence: [
          "denied changes: README.md",
          "missing required changes matching: src/**",
        ],
        gateId: "changed-policy",
        kind: "changed_files",
        nodeId: "node-a",
        passed: false,
        reason: "changed-file policy failed",
      },
    ]);
    expect(context.gates).toEqual(results);
    expect(reporterEvents).toEqual([
      {
        gateId: "changed-policy",
        kind: "changed_files",
        nodeId: "node-a",
        type: "gate.start",
      },
      {
        evidence: [
          "denied changes: README.md",
          "missing required changes matching: src/**",
        ],
        gateId: "changed-policy",
        kind: "changed_files",
        nodeId: "node-a",
        passed: false,
        reason: "changed-file policy failed",
        type: "gate.finish",
      },
    ]);
    expect(observability).toEqual([
      expect.objectContaining({
        actor: {
          id: "pipeline.gate.run-direct.direct-gates.node-a.changed-policy",
          kind: "gate",
          systemId: "pipeline.pipeline.run-direct.direct-gates",
        },
        gateId: "changed-policy",
        kind: "changed_files",
        nodeId: "node-a",
        type: "runtime.gate.started",
      }),
      expect.objectContaining({
        gateId: "changed-policy",
        kind: "changed_files",
        nodeId: "node-a",
        passed: false,
        reason: "changed-file policy failed",
        type: "runtime.gate.finished",
      }),
      expect.objectContaining({
        gateId: "changed-policy",
        kind: "changed_files",
        nodeId: "node-a",
        reason: "changed-file policy failed",
        type: "runtime.gate.failed",
      }),
    ]);
    expect(JSON.stringify(observability)).not.toContain("@xstate");
    expect(JSON.stringify(observability)).not.toContain("snapshot");
  });
});
