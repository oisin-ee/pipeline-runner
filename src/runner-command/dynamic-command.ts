import type { Scope } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { match } from "effect/Result";
import * as Schema from "effect/Schema";

import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config";
import { loadMokaDbUrl } from "../moka-global-config";
import { resolveRunControlStore } from "../run-control/run-control-store";
import type { RunControlStore } from "../run-control/run-control-store";
import { parseRunnerCommandPayload } from "../runner-command-contract";
import type { RunnerCommandPayload } from "../runner-command-contract";
import { resolveDurableStore } from "../runtime/durable-store/acquisition";
import type { DurableRunStore } from "../runtime/durable-store/durable-store";
import type { FileSystemService } from "../runtime/services/file-system-service";
import { FileSystemServiceLive } from "../runtime/services/file-system-service";
import {
  isOutputStream,
  RunnerCommandIoService,
  RunnerCommandIoServiceLive,
} from "../runtime/services/runner-command-io-service";
import type { OutputStream } from "../runtime/services/runner-command-io-service";
import { parseResultWithSchema } from "../schema-boundary";

export const DYNAMIC_COMMAND_EXIT = {
  fail: 1,
  pass: 0,
  startup: 70,
  validation: 64,
} as const;

export interface DynamicRunnerPersistence {
  durableStore: DurableRunStore;
  runControlStore: RunControlStore;
}

export type ResolveDynamicRunnerPersistence = (context: {
  runId: string;
  worktreePath: string;
}) => Effect.Effect<DynamicRunnerPersistence, unknown, Scope.Scope>;

export interface DynamicRunnerCommandOptions {
  cwd?: string;
  payloadFile: string;
  resolvePersistence?: ResolveDynamicRunnerPersistence;
  stderr?: OutputStream;
}

export interface DynamicRunnerContext {
  config: PipelineConfig;
  payload: RunnerCommandPayload;
  persistence: DynamicRunnerPersistence;
  worktreePath: string;
}

export const runScopedDynamicRunnerCommand = async <
  S extends Schema.ConstraintDecoder<unknown> & {
    readonly Encoded: DynamicRunnerCommandOptions;
    readonly Type: DynamicRunnerCommandOptions;
  },
>(
  schema: S,
  rawOptions: Partial<S["Encoded"]>,
  runEffect: (
    options: S["Type"] & { stderr: OutputStream }
  ) => Effect.Effect<
    number,
    never,
    FileSystemService | RunnerCommandIoService | Scope.Scope
  >
): Promise<number> => {
  const parsed = parseResultWithSchema(schema, rawOptions, {
    onExcessProperty: "error",
  });
  const stderr = isOutputStream(rawOptions.stderr)
    ? rawOptions.stderr
    : process.stderr;
  if (!parsed.ok) {
    stderr.write(`${parsed.error.message}\n`);
    return DYNAMIC_COMMAND_EXIT.validation;
  }
  const options = { ...parsed.value, stderr };
  return await Effect.runPromise(
    Effect.provide(
      Effect.provide(
        Effect.scoped(runEffect(options)),
        RunnerCommandIoServiceLive
      ),
      FileSystemServiceLive
    )
  );
};

const dynamicRunnerCommandErrorExit = (
  error: unknown,
  stderr: Option.Option<OutputStream>
): number => {
  const message = error instanceof Error ? error.message : String(error);
  Option.match(stderr, {
    onNone: () => {
      /* empty */
    },
    onSome: (stream) => {
      stream.write(`${message}\n`);
    },
  });
  return error instanceof Schema.SchemaError
    ? DYNAMIC_COMMAND_EXIT.validation
    : DYNAMIC_COMMAND_EXIT.startup;
};

export const dynamicRunnerCommandExitEffect = <R>(
  program: Effect.Effect<number, unknown, R>,
  stderr: Option.Option<OutputStream>
): Effect.Effect<number, never, R> =>
  Effect.gen(function* effectBody() {
    const result = yield* Effect.result(program);
    return match(result, {
      onFailure: (error) => dynamicRunnerCommandErrorExit(error, stderr),
      onSuccess: (exitCode) => exitCode,
    });
  });

const dynamicRunnerPersistenceEffect = (
  options: DynamicRunnerCommandOptions,
  context: { runId: string; worktreePath: string }
): Effect.Effect<DynamicRunnerPersistence, unknown, Scope.Scope> => {
  if (options.resolvePersistence !== undefined) {
    return options.resolvePersistence(context);
  }
  const dbUrl = loadMokaDbUrl();
  return Effect.gen(function* effectBody() {
    const durableStore = yield* resolveDurableStore(dbUrl, context.runId);
    const runControlStore = yield* resolveRunControlStore(
      dbUrl,
      context.worktreePath
    );
    return { durableStore, runControlStore };
  });
};

export const dynamicRunnerContextEffect = (
  options: DynamicRunnerCommandOptions
): Effect.Effect<
  DynamicRunnerContext,
  unknown,
  RunnerCommandIoService | Scope.Scope
> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    const payloadRaw = yield* io.readText(options.payloadFile);
    const payload = yield* Effect.try({
      catch: (error) => error,
      try: () => parseRunnerCommandPayload(payloadRaw),
    });
    const worktreePath = yield* io.prepareRunnerGitWorkspace(payload, {
      cwd: options.cwd,
    });
    const config = yield* Effect.try({
      catch: (error) => error,
      try: () =>
        loadPipelineConfig(worktreePath, {
          allowMissingLintFileReferences: true,
        }),
    });
    const persistence = yield* dynamicRunnerPersistenceEffect(options, {
      runId: payload.run.id,
      worktreePath,
    });
    return { config, payload, persistence, worktreePath };
  });
