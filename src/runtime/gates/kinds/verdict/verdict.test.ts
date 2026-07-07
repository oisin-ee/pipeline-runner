import { describe, expect, it } from "vitest";

import type { NodeAttemptResult, VerdictGateSpec } from "../../../contracts";
import type { JsonSourceContext } from "../../gates";
import { evaluateVerdictGate } from "./verdict";

const ctx: JsonSourceContext = { worktreePath: process.cwd() };

const attempt = (output: string): NodeAttemptResult => ({
  evidence: [],
  exitCode: 0,
  output,
});

describe("evaluateVerdictGate", () => {
  it("passes when the verdict field equals the expected value", () => {
    const gate: VerdictGateSpec = { kind: "verdict", target: "stdout" };
    const result = evaluateVerdictGate(
      gate,
      "verdict:node",
      "node",
      ctx,
      attempt(JSON.stringify({ verdict: "PASS" }))
    );
    expect(result.passed).toBe(true);
    expect(result.kind).toBe("verdict");
    expect(result.reason).toBeUndefined();
  });

  it("fails when the verdict field does not match", () => {
    const gate: VerdictGateSpec = { kind: "verdict", target: "stdout" };
    const result = evaluateVerdictGate(
      gate,
      "verdict:node",
      "node",
      ctx,
      attempt(JSON.stringify({ verdict: "FAIL" }))
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("verdict requirement failed");
  });

  it("fails when JSON is unparseable", () => {
    const gate: VerdictGateSpec = { kind: "verdict", target: "stdout" };
    const result = evaluateVerdictGate(
      gate,
      "verdict:node",
      "node",
      ctx,
      attempt("not-json")
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("verdict gate JSON parse failed");
  });

  it("respects a custom field and equals value", () => {
    const gate: VerdictGateSpec = {
      equals: "OK",
      field: "status",
      kind: "verdict",
      target: "stdout",
    };
    const result = evaluateVerdictGate(
      gate,
      "verdict:node",
      "node",
      ctx,
      attempt(JSON.stringify({ status: "OK" }))
    );
    expect(result.passed).toBe(true);
  });
});
