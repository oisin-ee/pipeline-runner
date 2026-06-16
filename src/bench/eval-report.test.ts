import { describe, expect, it } from "vitest";
import {
  buildEvalReport,
  type EvalRunResult,
  renderEvalReport,
} from "./eval-report";

const results: EvalRunResult[] = [
  {
    costTokens: 1000,
    resolved: true,
    task: "t1",
    variant: "baseline",
    wallMs: 100,
  },
  {
    costTokens: 1200,
    resolved: false,
    task: "t2",
    variant: "baseline",
    wallMs: 200,
  },
  {
    costTokens: 3000,
    resolved: true,
    task: "t1",
    variant: "pipeline",
    wallMs: 300,
  },
  {
    costTokens: 3400,
    resolved: true,
    task: "t2",
    variant: "pipeline",
    wallMs: 500,
  },
];

describe("buildEvalReport", () => {
  it("aggregates resolution rate, cost, and wall time per variant", () => {
    const report = buildEvalReport(results);

    expect(report.tasks).toBe(2);
    const baseline = report.variants.find((v) => v.variant === "baseline");
    const pipeline = report.variants.find((v) => v.variant === "pipeline");
    expect(baseline?.resolutionRate).toBe(0.5);
    expect(baseline?.totalCostTokens).toBe(2200);
    expect(baseline?.avgWallMs).toBe(150);
    expect(pipeline?.resolutionRate).toBe(1);
    expect(pipeline?.totalCostTokens).toBe(6400);
  });

  it("renders a compact comparison table", () => {
    const text = renderEvalReport(buildEvalReport(results));

    expect(text).toContain("Eval over 2 task(s)");
    expect(text).toContain("baseline | 1/2 | 50%");
    expect(text).toContain("pipeline | 2/2 | 100%");
  });

  it("handles an empty result set", () => {
    expect(buildEvalReport([])).toEqual({ tasks: 0, variants: [] });
  });
});
