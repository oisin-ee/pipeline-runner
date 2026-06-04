import { describe, expect, it } from "vitest";
import type {
  AcceptanceCriterion,
  ChangedFilesGateSpec,
  RuntimeContext,
} from "../contracts";
import { acceptanceCoverageEvidence, evaluateChangedFilesGate } from "./gates";

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
      nodeSnapshots: new Map([
        [
          "node-a",
          {
            files: new Set(["src/app.ts", "README.md", "?? scratch.txt"]),
            fingerprints: new Map(),
          },
        ],
      ]),
    } as Pick<RuntimeContext, "nodeSnapshots">;
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
});
