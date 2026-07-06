import type { Scope } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { match } from "effect/Result";
import * as Schema from "effect/Schema";

import { readyNodeIdsFromRunStore } from "../run-control/next-node";
import { FileSystemService } from "../runtime/services/file-system-service";
import { isOutputStream } from "../runtime/services/runner-command-io-service";
import { RunnerCommandIoService } from "../runtime/services/runner-command-io-service";
import type { OutputStream } from "../runtime/services/runner-command-io-service";
import { requiredString, struct } from "../schema-boundary";
import {
  DYNAMIC_COMMAND_EXIT,
  dynamicRunnerCommandErrorExit,
  dynamicRunnerContextEffect,
  runScopedDynamicRunnerCommand,
} from "./dynamic-command";
import type { ResolveDynamicRunnerPersistence } from "./dynamic-command";

const outputStream = Schema.declare<OutputStream>(isOutputStream);
const resolvePersistence = Schema.declare<ResolveDynamicRunnerPersistence>(
  (value): value is ResolveDynamicRunnerPersistence => P.isFunction(value),
);
const readyNodeIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeReadyNodeIdsJson = Schema.encodeSync(readyNodeIdsJson);

const selectReadyWaveOptionsSchema = struct({
  cwd: Schema.optional(requiredString),
  outputFile: requiredString,
  payloadFile: requiredString,
  resolvePersistence: Schema.optional(resolvePersistence),
  stderr: Schema.optional(outputStream),
  stdout: Schema.optional(outputStream),
});

export type SelectReadyWaveOptions = typeof selectReadyWaveOptionsSchema.Encoded;

const selectReadyWaveProgram = (
  options: typeof selectReadyWaveOptionsSchema.Type,
): Effect.Effect<number, unknown, FileSystemService | RunnerCommandIoService | Scope.Scope> =>
  Effect.gen(function* effectBody() {
    const { config, payload, persistence, worktreePath } = yield* dynamicRunnerContextEffect(options);
    const readyNodeIds = yield* readyNodeIdsFromRunStore({
      config,
      durableStore: persistence.durableStore,
      runControlStore: persistence.runControlStore,
      runId: payload.run.id,
      worktreePath,
    });
    const fileSystem = yield* FileSystemService;
    yield* fileSystem.writeText(options.outputFile, `${encodeReadyNodeIdsJson(readyNodeIds)}\n`);
    return DYNAMIC_COMMAND_EXIT.pass;
  });

const runSelectReadyWaveEffect = (
  options: typeof selectReadyWaveOptionsSchema.Type,
): Effect.Effect<number, never, FileSystemService | RunnerCommandIoService | Scope.Scope> =>
  Effect.gen(function* effectBody() {
    const result = yield* Effect.result(selectReadyWaveProgram(options));
    return match(result, {
      onFailure: (error) => dynamicRunnerCommandErrorExit(error, Option.fromNullishOr(options.stderr)),
      onSuccess: (exitCode) => exitCode,
    });
  });

export const runSelectReadyWave = async (rawOptions: Partial<SelectReadyWaveOptions> = {}): Promise<number> =>
  await runScopedDynamicRunnerCommand(selectReadyWaveOptionsSchema, rawOptions, runSelectReadyWaveEffect);
