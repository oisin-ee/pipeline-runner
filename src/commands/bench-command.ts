import { readFileSync } from "node:fs";

import type { Command } from "commander";
import { Context, Effect, Layer } from "effect";

import { buildEvalReport, renderEvalReport } from "../bench/eval-report";
import type { EvalRunResult } from "../bench/eval-report";

class BenchCommandService extends Context.Service<
  BenchCommandService,
  {
    readonly readResults: (
      path: string
    ) => Effect.Effect<EvalRunResult[], unknown>;
    readonly writeReport: (report: string) => Effect.Effect<void, unknown>;
  }
>()("BenchCommandService") {}

const BenchCommandServiceLive = Layer.succeed(BenchCommandService, {
  readResults: (path) =>
    Effect.try(
      () => JSON.parse(readFileSync(path, "utf-8")) as EvalRunResult[]
    ),
  writeReport: (report) =>
    Effect.try(() => process.stdout.write(`${report}\n`)),
});

const runBenchCommand = (options: { results: string }) =>
  Effect.gen(function* runBenchCommand() {
    const service = yield* BenchCommandService;
    const records = yield* service.readResults(options.results);
    const report = renderEvalReport(buildEvalReport(records));
    yield* service.writeReport(report);
  });

/**
 * PIPE-83.6: `moka bench` — score a flat single-agent baseline vs the pipeline
 * (and ablations) over a recorded run set. Runs are produced by executing the
 * bench task set (bench/tasks) through `moka run` for each variant and recording
 * one EvalRunResult per task+variant; this command turns those records into the
 * comparison report.
 */
export const registerBenchCommand = (program: Command): void => {
  program
    .command("bench")
    .description(
      "Score a flat single-agent baseline vs the pipeline over recorded bench runs"
    )
    .requiredOption(
      "--results <path>",
      "JSON file: array of { task, variant, resolved, costTokens, wallMs }"
    )
    .action(async (options: { results: string }) => {
      await Effect.runPromise(
        Effect.provide(runBenchCommand(options), BenchCommandServiceLive)
      );
    });
};
