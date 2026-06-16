import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { Context, Effect, Layer } from "effect";
import {
  buildEvalReport,
  type EvalRunResult,
  renderEvalReport,
} from "../bench/eval-report";

class BenchCommandService extends Context.Tag("BenchCommandService")<
  BenchCommandService,
  {
    readonly readResults: (
      path: string
    ) => Effect.Effect<EvalRunResult[], unknown>;
    readonly writeReport: (report: string) => Effect.Effect<void, unknown>;
  }
>() {}

const BenchCommandServiceLive = Layer.succeed(BenchCommandService, {
  readResults: (path) =>
    Effect.try(() => JSON.parse(readFileSync(path, "utf8")) as EvalRunResult[]),
  writeReport: (report) =>
    Effect.try(() => process.stdout.write(`${report}\n`)),
});

const runBenchCommand = (options: { results: string }) =>
  Effect.gen(function* () {
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
    .action((options: { results: string }) =>
      Effect.runPromise(
        Effect.provide(runBenchCommand(options), BenchCommandServiceLive)
      )
    );
}
