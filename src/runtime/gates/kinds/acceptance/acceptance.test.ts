import { describe, expect, it } from "vitest";
import type {
  AcceptanceCriterion,
  AcceptanceGateSpec,
  NodeAttemptResult,
} from "../../../contracts";
import type { AcceptanceContext } from "../json-source";
import { acceptanceUnmetCriteria, evaluateAcceptanceGate } from "./acceptance";

const ctx: AcceptanceContext = {
  taskContext: undefined,
  worktreePath: process.cwd(),
};

function attempt(output: unknown): NodeAttemptResult {
  return { evidence: [], exitCode: 0, output: JSON.stringify(output) };
}

describe("evaluateAcceptanceGate", () => {
  it("passes when all criteria are covered with PASS verdicts and evidence", () => {
    const gate: AcceptanceGateSpec = { kind: "acceptance", target: "stdout" };
    const contextWithTask: AcceptanceContext = {
      ...ctx,
      taskContext: {
        acceptanceCriteria: [
          { id: "A", text: "Alpha" },
          { id: "B", text: "Beta" },
        ],
      },
    };
    const result = evaluateAcceptanceGate(
      gate,
      "accept:node",
      "node",
      contextWithTask,
      attempt({
        acceptance: [
          { evidence: ["ok"], id: "A", verdict: "PASS" },
          { evidence: ["fine"], id: "B", verdict: "PASS" },
        ],
      })
    );
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("acceptance");
  });

  it("fails when a criterion is missing from the report", () => {
    const gate: AcceptanceGateSpec = { kind: "acceptance", target: "stdout" };
    const contextWithTask: AcceptanceContext = {
      ...ctx,
      taskContext: { acceptanceCriteria: [{ id: "A", text: "Alpha" }] },
    };
    const result = evaluateAcceptanceGate(
      gate,
      "accept:node",
      "node",
      contextWithTask,
      attempt({ acceptance: [] })
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("acceptance coverage failed");
  });

  it("passes (required=false) when no task context is set", () => {
    const gate: AcceptanceGateSpec = {
      kind: "acceptance",
      required: false,
      target: "stdout",
    };
    const result = evaluateAcceptanceGate(
      gate,
      "accept:node",
      "node",
      ctx,
      attempt({})
    );
    expect(result.passed).toBe(true);
  });
});

describe("acceptanceUnmetCriteria", () => {
  it("returns empty when all criteria are met with evidence", () => {
    const expected: AcceptanceCriterion[] = [{ id: "A", text: "Alpha" }];
    expect(
      acceptanceUnmetCriteria(expected, [
        { evidence: ["ok"], id: "A", verdict: "PASS" },
      ])
    ).toEqual([]);
  });

  it("reports a missing criterion when the entry list is empty", () => {
    const expected: AcceptanceCriterion[] = [{ id: "X", text: "Must exist" }];
    const unmet = acceptanceUnmetCriteria(expected, []);
    expect(unmet).toEqual([
      {
        criterion: "X",
        evidence: ["criterion 'X' absent from acceptance report"],
        reason: "missing acceptance criterion 'X'",
      },
    ]);
  });
});
