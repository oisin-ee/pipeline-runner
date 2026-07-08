import { readFileSync } from "node:fs";

import { Context, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  buildEvalReport,
  parseEvalRunResultsJson,
  renderEvalReport,
} from "../bench/eval-report";
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
    Effect.try(() => parseEvalRunResultsJson(readFileSync(path, "utf-8"))),
  writeReport: (report) =>
    Effect.try(() => process.stdout.write(`${report}\n`)),
});

const runBenchCommand = (options: { results: string }) =>
  Effect.gen(function* effectBody() {
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
export const createBenchCommand = () =>
  Command.make(
    "bench",
    {
      results: Flag.string("results").pipe(
        Flag.withDescription(
          "JSON file: array of { task, variant, resolved, costTokens, wallMs }"
        )
      ),
    },
    (options) =>
      Effect.provide(runBenchCommand(options), BenchCommandServiceLive)
  ).pipe(
    Command.withDescription(
      "Score a flat single-agent baseline vs the pipeline over recorded bench runs"
    )
  );
