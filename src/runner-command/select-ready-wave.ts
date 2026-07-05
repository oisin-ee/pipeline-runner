import { writeFileSync } from "node:fs";

import { Effect, Option } from "effect";
import type { Scope } from "effect";
import { z } from "zod";

import { readyNodeIdsFromRunStore } from "../run-control/next-node";
import { isOutputStream } from "../runtime/services/runner-command-io-service";
import type {
  OutputStream,
  RunnerCommandIoService,
} from "../runtime/services/runner-command-io-service";
import {
  DYNAMIC_COMMAND_EXIT,
  dynamicRunnerCommandErrorExit,
  dynamicRunnerContextEffect,
  runScopedDynamicRunnerCommand,
} from "./dynamic-command";
import type { ResolveDynamicRunnerPersistence } from "./dynamic-command";

const selectReadyWaveOptionsSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    outputFile: z.string().min(1),
    payloadFile: z.string().min(1),
    resolvePersistence: z
      .custom<ResolveDynamicRunnerPersistence>(
        (value) => typeof value === "function"
      )
      .optional(),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    stdout: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    writeFile: z
      .custom<(path: string, content: string) => void>(
        (value) => typeof value === "function"
      )
      .default(() => writeFileSync),
  })
  .strict();

export type SelectReadyWaveOptions = z.input<
  typeof selectReadyWaveOptionsSchema
>;

const runSelectReadyWaveEffect = (
  options: z.output<typeof selectReadyWaveOptionsSchema>
): Effect.Effect<number, never, RunnerCommandIoService | Scope.Scope> =>
  Effect.gen(function* effectBody() {
    const { config, payload, persistence, worktreePath } =
      yield* dynamicRunnerContextEffect(options);
    const readyNodeIds = yield* readyNodeIdsFromRunStore({
      config,
      durableStore: persistence.durableStore,
      runControlStore: persistence.runControlStore,
      runId: payload.run.id,
      worktreePath,
    });
    options.writeFile(options.outputFile, `${JSON.stringify(readyNodeIds)}\n`);
    return DYNAMIC_COMMAND_EXIT.pass;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        dynamicRunnerCommandErrorExit(
          error,
          Option.fromNullishOr(options.stderr)
        )
      )
    )
  );

export const runSelectReadyWave = async (
  rawOptions: Partial<SelectReadyWaveOptions> = {}
): Promise<number> =>
  await runScopedDynamicRunnerCommand(
    selectReadyWaveOptionsSchema,
    rawOptions,
    runSelectReadyWaveEffect
  );
