import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  buildEvalReport,
  type EvalRunResult,
  renderEvalReport,
} from "../bench/eval-report";

/**
 * PIPE-83.6: `moka bench` — score a flat single-agent baseline vs the pipeline
 * (and ablations) over a recorded run set. Runs are produced by executing the
 * bench task set (bench/tasks) through `moka run` for each variant and recording
 * one EvalRunResult per task+variant; this command turns those records into the
 * comparison report.
 */
export function registerBenchCommand(program: Command): void {
  program
    .command("bench")
    .description(
      "Score a flat single-agent baseline vs the pipeline over recorded bench runs"
    )
    .requiredOption(
      "--results <path>",
      "JSON file: array of { task, variant, resolved, costTokens, wallMs }"
    )
    .action((options: { results: string }) => {
      const records = JSON.parse(
        readFileSync(options.results, "utf8")
      ) as EvalRunResult[];
      process.stdout.write(`${renderEvalReport(buildEvalReport(records))}\n`);
    });
}
