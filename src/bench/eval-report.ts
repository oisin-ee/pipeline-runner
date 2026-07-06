import {
  booleanValue,
  mutableArray,
  numberValue,
  parseJsonWithSchema,
  requiredString,
  struct,
} from "../schema-boundary";

/**
 * PIPE-83.3/83.6: eval harness scoring. Aggregates per-task run outcomes for a
 * flat single-agent baseline vs the full pipeline (and ablations) into a
 * comparison report, so "does selection-over-N / the pipeline beat one strong
 * agent?" is measured, not assumed (see memory: project_architecture_verdict).
 *
 * Runs are produced separately (`moka run` over bench/tasks, recording one
 * EvalRunResult per task+variant); this module turns them into the report. Pure
 * and deterministic — no model calls.
 */
const evalRunResultSchema = struct({
  costTokens: numberValue(),
  resolved: booleanValue(),
  task: requiredString,
  variant: requiredString,
  wallMs: numberValue(),
});

const evalRunResultsSchema = mutableArray(evalRunResultSchema);

export type EvalRunResult = typeof evalRunResultSchema.Type;

export const parseEvalRunResultsJson = (source: string): EvalRunResult[] =>
  parseJsonWithSchema(evalRunResultsSchema, source);

export interface VariantSummary {
  avgWallMs: number;
  count: number;
  resolutionRate: number;
  resolved: number;
  totalCostTokens: number;
  variant: string;
}

export interface EvalReport {
  tasks: number;
  variants: VariantSummary[];
}

const summarizeVariant = (variant: string, runs: EvalRunResult[]): VariantSummary => {
  const resolved = runs.filter((r) => r.resolved).length;
  const totalWall = runs.reduce((sum, r) => sum + r.wallMs, 0);
  return {
    avgWallMs: runs.length ? Math.round(totalWall / runs.length) : 0,
    count: runs.length,
    resolutionRate: runs.length ? resolved / runs.length : 0,
    resolved,
    totalCostTokens: runs.reduce((sum, r) => sum + r.costTokens, 0),
    variant,
  };
};

export const buildEvalReport = (results: EvalRunResult[]): EvalReport => {
  const variants = [...new Set(results.map((r) => r.variant))].toSorted();
  return {
    tasks: new Set(results.map((r) => r.task)).size,
    variants: variants.map((variant) =>
      summarizeVariant(
        variant,
        results.filter((r) => r.variant === variant),
      ),
    ),
  };
};

export const renderEvalReport = (report: EvalReport): string => {
  const lines = [`Eval over ${report.tasks} task(s):`, "variant | resolved | rate | tokens | avg ms"];
  for (const v of report.variants) {
    lines.push(
      `${v.variant} | ${v.resolved}/${v.count} | ${(v.resolutionRate * 100).toFixed(0)}% | ${v.totalCostTokens} | ${v.avgWallMs}`,
    );
  }
  return lines.join("\n");
};
