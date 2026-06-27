import { describe, expect, it } from "vitest";
import {
  baseGateRuntimeFields,
  gateNodeStateStore,
} from "../../../tests/gate-test-context";
import { parsePipelineConfigParts } from "../../config/load";
import { compileWorkflowPlan } from "../../planning/compile";
import type { RuntimeObservabilityEvent } from "../actor-ids";
import type {
  AcceptanceCriterion,
  ChangedFilesGateSpec,
  PipelineRuntimeEvent,
  RuntimeContext,
} from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { acceptanceUnmetCriteria } from "./kinds/acceptance/acceptance";
import { evaluateChangedFilesGate } from "./kinds/changed-files/changed-files";
import { evaluateNodeGates } from "./orchestrator";

function changedFilesContext(
  files: string[]
): Pick<RuntimeContext, "nodeStateStore"> {
  return {
    nodeStateStore: new NodeStateStore({
      nodeSnapshots: new Map([
        ["node-a", { files: new Set(files), fingerprints: new Map() }],
      ]),
    }),
  } satisfies Pick<RuntimeContext, "nodeStateStore">;
}

function directGateRuntimeContext(
  observability: RuntimeObservabilityEvent[],
  reporterEvents: PipelineRuntimeEvent[]
): RuntimeContext {
  const config = parsePipelineConfigParts(
    {
      pipeline: `
version: 1
default_workflow: direct-gates
workflows:
  direct-gates:
    nodes:
      - id: node-a
        kind: agent
        profile: direct
        gates:
          - id: changed-policy
            kind: changed_files
            changed_files:
              deny: ["**/*.md"]
              require_any: ["src/**"]
`,
      profiles: `
version: 1
profiles:
  direct:
    runner: local
    instructions: { inline: Direct gate test }
`,
      runners: `
version: 1
runners:
  local:
    type: command
    command: node
    capabilities: { native_subagents: false }
`,
    },
    "/tmp/direct-gates-test"
  );
  const plan = compileWorkflowPlan(config);

  return {
    ...baseGateRuntimeFields(),
    config,
    nodeStateStore: gateNodeStateStore("node-a", ["README.md"]),
    observability: (event) => observability.push(event),
    plan,
    reporter: (event) => reporterEvents.push(event),
    runId: "run-direct",
    task: "exercise direct gate evaluation",
    workflowId: "direct-gates",
    worktreePath: process.cwd(),
  };
}

describe("runtime gates", () => {
  it("reports structured unmet criteria for missing, duplicate, extra, failing, and unevidenced acceptance coverage", () => {
    const expected: AcceptanceCriterion[] = [
      { id: "A", text: "Alpha" },
      { id: "B", text: "Beta" },
    ];

    const unmet = acceptanceUnmetCriteria(expected, [
      { evidence: ["ok"], id: "A", verdict: "PASS" },
      { evidence: ["again"], id: "A", verdict: "PASS" },
      { evidence: [], id: "C", verdict: "PASS" },
      { evidence: ["no"], id: "B", verdict: "FAIL" },
      { verdict: "PASS" },
    ]);

    // A FAILED gate populates unmet[] with one actionable entry per unmet
    // criterion: which criterion, why, and the deterministic proof.
    expect(unmet).toEqual([
      {
        criterion: "C",
        evidence: ["id 'C' not in task acceptance context"],
        reason: "extra acceptance criterion 'C'",
      },
      {
        criterion: "C",
        evidence: ["verdict 'PASS' reported without supporting evidence"],
        reason: "acceptance criterion 'C' has no evidence",
      },
      {
        criterion: "B",
        evidence: ["reported verdict 'FAIL'"],
        reason: "acceptance criterion 'B' verdict 'FAIL'",
      },
      {
        criterion: "",
        evidence: ["acceptance entry has no id field"],
        reason: "acceptance entry missing id",
      },
      {
        criterion: "A",
        evidence: ["criterion 'A' reported 2 times"],
        reason: "duplicate acceptance criterion 'A'",
      },
    ]);
  });

  it("returns an empty unmet list when every acceptance criterion passes with evidence", () => {
    const expected: AcceptanceCriterion[] = [
      { id: "A", text: "Alpha" },
      { id: "B", text: "Beta" },
    ];

    expect(
      acceptanceUnmetCriteria(expected, [
        { evidence: ["ok"], id: "A", verdict: "PASS" },
        { evidence: ["fine"], id: "B", verdict: "PASS" },
      ])
    ).toEqual([]);
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

  it("allows monorepo-nested test support files under the test-writer policy", () => {
    // The test-writer allow-list must accept test infrastructure nested inside
    // monorepo packages (e.g. apps/app/tests/support/*.ts), not just root-level
    // tests/. Root-anchored "tests/**" misses apps/app/tests/...; "**/tests/**"
    // matches it. Mirrors the baseline red-tests changed_files policy.
    const context = changedFilesContext([
      "apps/app/tests/support/avatar-upload.ts",
      "apps/app/tests/profile-form/profile-form.test.tsx",
    ]);
    const gate: ChangedFilesGateSpec = {
      changed_files: {
        allow: [
          "**/*.test.*",
          "**/*.spec.*",
          "**/*_test.*",
          "**/__tests__/**",
          "test/**",
          "tests/**",
          "**/test/**",
          "**/tests/**",
          "**/*.snap",
        ],
        require_any: ["**/*.test.*", "**/tests/**"],
      },
      kind: "changed_files",
    };

    const result = evaluateChangedFilesGate(
      gate,
      "changed:node-a",
      "node-a",
      context
    );
    expect(result.passed).toBe(true);
    expect(
      result.evidence.some((line) => line.includes("outside allow list"))
    ).toBe(false);
  });

  it("excludes supervisor run-state but still gates real disallowed source changes", () => {
    const context = changedFilesContext([
      "src/app.ts",
      "README.md",
      ".pipeline/journal/run-4a0f183d.jsonl",
      ".pipeline/runs/run-4a0f183d/runtime-events.jsonl",
      ".pipeline/runs/run-4a0f183d/status.json",
      ".pipeline/runs/run-4a0f183d/nodes/red-app/stdout.jsonl",
    ]);
    const gate: ChangedFilesGateSpec = {
      changed_files: { allow: ["src/**"] },
      kind: "changed_files",
    };

    const result = evaluateChangedFilesGate(
      gate,
      "changed:node-a",
      "node-a",
      context
    );

    // README.md is the only genuine violation; no .pipeline run-state leaks in.
    expect(result.passed).toBe(false);
    expect(result.evidence).toEqual(["changes outside allow list: README.md"]);
    expect(JSON.stringify(result.evidence)).not.toContain(".pipeline");
  });

  it("does not let supervisor run-state satisfy require_any for source/tests", () => {
    const context = changedFilesContext([
      ".pipeline/runs/run-4a0f183d/status.json",
      ".pipeline/journal/run-4a0f183d.jsonl",
    ]);
    const gate: ChangedFilesGateSpec = {
      changed_files: { require_any: ["src/**", "**/*.test.ts"] },
      kind: "changed_files",
    };

    const result = evaluateChangedFilesGate(
      gate,
      "changed:node-a",
      "node-a",
      context
    );

    expect(result.passed).toBe(false);
    expect(result.evidence).toEqual([
      "missing required changes matching: src/**, **/*.test.ts",
    ]);
  });

  it("passes when only allowed source and supervisor run-state changed", () => {
    const context = changedFilesContext([
      "src/app.ts",
      ".pipeline/runs/run-4a0f183d/status.json",
      // untracked-prefixed shape is normalized before run-state matching.
      "?? .pipeline/runs/run-4a0f183d/nodes/green-app/stdout.jsonl",
    ]);
    const gate: ChangedFilesGateSpec = {
      changed_files: { allow: ["src/**"], require_any: ["src/**"] },
      kind: "changed_files",
    };

    const result = evaluateChangedFilesGate(
      gate,
      "changed:node-a",
      "node-a",
      context
    );

    expect(result).toEqual({
      evidence: ["changed files: src/app.ts"],
      gateId: "changed:node-a",
      kind: "changed_files",
      nodeId: "node-a",
      passed: true,
      reason: undefined,
    });
  });

  it("evaluates gates directly while preserving result and observability contracts", async () => {
    const observability: RuntimeObservabilityEvent[] = [];
    const reporterEvents: PipelineRuntimeEvent[] = [];
    const context = directGateRuntimeContext(observability, reporterEvents);
    const node = context.plan.topologicalOrder[0];
    if (!node) {
      throw new Error("direct gate test plan did not compile node-a");
    }

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
    expect(JSON.stringify(observability)).not.toContain("snapshot");
  });
});
