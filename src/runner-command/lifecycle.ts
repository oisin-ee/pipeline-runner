import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isFailure, match } from "effect/Result";
import * as Schema from "effect/Schema";

import { loadMokaDbUrl } from "../moka-global-config";
import { resolveRunControlStore } from "../run-control/run-control-store";
import type { CreateRunRequest } from "../run-control/run-control-store";
import { buildRemoteRunCreateRequest } from "../run-control/run-record";
import type { RemoteRunRecordOptions } from "../run-control/run-record";
import {
  emitWorkflowPlanned,
  emitWorkflowStarted,
} from "../runtime/events/events";
import { dispatchHooks } from "../runtime/hooks";
import {
  flushAndReport,
  isOutputStream,
  runValidatedRunnerCommand,
} from "../runtime/services/runner-command-io-service";
import type {
  OutputStream,
  RunnerCommandIoService,
} from "../runtime/services/runner-command-io-service";
import { runWorkflowStartLifecycle } from "../runtime/workflow-lifecycle";
import { requiredString, struct } from "../schema-boundary";
import { createRunnerLifecycleContextEffect } from "./lifecycle-context";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

/**
 * PIPE-94.5: injectable override for the in-pod createRun upsert. Receives the
 * COMPLETE {@link CreateRunRequest} (real nodeIds already compiled by
 * {@link buildRemoteRunCreateRequest}), so tests can assert the persisted node
 * list without touching `loadMokaDbUrl` or the Postgres store.
 */
type LifecycleUpsertRunRecord = (request: CreateRunRequest) => Promise<void>;

const fetchLike = Schema.declare<FetchLike>(
  (value): value is FetchLike => typeof value === "function"
);
const outputStream = Schema.declare<OutputStream>(isOutputStream);
const upsertRunRecord = Schema.declare<LifecycleUpsertRunRecord>(
  (value): value is LifecycleUpsertRunRecord => typeof value === "function"
);

const runnerLifecycleOptionsSchema = struct({
  cwd: Schema.optional(requiredString),
  fetch: Schema.optional(fetchLike),
  payloadFile: requiredString,
  phase: Schema.Literal("workflow.start"),
  scheduleFile: requiredString,
  stderr: Schema.optional(outputStream),
  upsertRunRecord: Schema.optional(upsertRunRecord),
});

export type RunnerLifecycleOptions =
  typeof runnerLifecycleOptionsSchema.Encoded;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

type LifecycleRunRecordWriter = (
  request: CreateRunRequest
) => Effect.Effect<unknown, unknown>;

/**
 * Select the createRun write target: the injected override (test/custom seam),
 * or the db.url-resolved run-control store. Returns undefined — and logs the
 * deliberate skip — when no override is set and db.url is absent (no durable
 * substrate configured for this pod).
 */
const resolveLifecycleRunRecordWriter = (
  options: RemoteRunRecordOptions,
  upsertOverride: Option.Option<LifecycleUpsertRunRecord>,
  stderr: OutputStream
): Effect.Effect<Option.Option<LifecycleRunRecordWriter>> =>
  Effect.sync(() => {
    if (Option.isSome(upsertOverride)) {
      return Option.some((request: CreateRunRequest) =>
        Effect.tryPromise({
          catch: (error) => error,
          try: async () => {
            await upsertOverride.value(request);
          },
        })
      );
    }
    const dbUrl = loadMokaDbUrl();
    if (dbUrl === undefined) {
      stderr.write(
        `runner-lifecycle: db.url not configured — skipping createRun for run ${options.runId}\n`
      );
      return Option.none();
    }
    return Option.some((request: CreateRunRequest) =>
      Effect.scoped(
        resolveRunControlStore(dbUrl, options.worktreePath ?? "").pipe(
          Effect.flatMap((store) => store.createRun(request))
        )
      )
    );
  });

const logUpsertError = (
  stderr: OutputStream,
  runId: string,
  error: unknown
): void => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(
    `runner-lifecycle: createRun failed — run ${runId} will still execute: ${message}\n`
  );
};

/**
 * PIPE-94.5: attempt to upsert the run record into the durable store.
 *
 * Guard contract:
 *  - injectable override present → delegate to it (tests / custom impls).
 *  - db.url absent → log + skip (no substrate configured for this pod).
 *  - schedule compile or store call fails → log + skip (run executes; status
 *    just will not persist).
 *  - Never throws / never fails the lifecycle.
 */
const upsertLifecycleRunRecordEffect = (
  options: RemoteRunRecordOptions,
  upsertOverride: Option.Option<LifecycleUpsertRunRecord>,
  stderr: OutputStream
): Effect.Effect<void> =>
  Effect.gen(function* effectBody() {
    const result = yield* Effect.result(
      Effect.gen(function* upsertLifecycleRunRecordProgram() {
        const write = yield* resolveLifecycleRunRecordWriter(
          options,
          upsertOverride,
          stderr
        );
        if (Option.isNone(write)) {
          return;
        }
        // Effect.try keeps a schedule-compile throw in the typed error channel
        // so result matching logs it rather than crashing workflow.start.
        const request = yield* Effect.try({
          catch: (error) => error,
          try: () => buildRemoteRunCreateRequest(options),
        });
        yield* write.value(request);
      })
    );
    if (isFailure(result)) {
      logUpsertError(stderr, options.runId, result.failure);
    }
  });

const lifecycleErrorExitCode = (error: unknown, stderr: OutputStream) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  return error instanceof Schema.SchemaError ? EXIT_VALIDATION : EXIT_STARTUP;
};

const runRunnerLifecycleEffect = (
  options: RunnerLifecycleOptions,
  stderr: OutputStream
): Effect.Effect<number, never, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const result = yield* Effect.result(
      Effect.gen(function* runnerLifecycleProgram() {
        const { compiled, context, payload, scheduleYaml, sink, worktreePath } =
          yield* createRunnerLifecycleContextEffect(options);

        // PIPE-94.5: upsert the run record (idempotent floor — runs even when
        // the submit-side upsert (PIPE-94.4) was skipped due to absent db.url or
        // outage). The shared builder compiles the real node list from the same
        // schedule + config the submit path uses, so first-writer-wins is lossless.
        yield* upsertLifecycleRunRecordEffect(
          {
            config: compiled.config,
            runId: payload.run.id,
            scheduleYaml,
            worktreePath,
          },
          Option.fromNullishOr(options.upsertRunRecord),
          stderr
        );

        const failure = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await runWorkflowStartLifecycle({
              emitWorkflowPlanned: () => {
                emitWorkflowPlanned(context);
              },
              emitWorkflowStarted: () => {
                emitWorkflowStarted(context);
              },
              runWorkflowHook: async (event) =>
                Option.fromNullishOr(await dispatchHooks(context, event)),
            }),
        });
        yield* flushAndReport(sink, stderr);
        return Option.isSome(failure) ? EXIT_FAIL : EXIT_PASS;
      })
    );
    return match(result, {
      onFailure: (error) => lifecycleErrorExitCode(error, stderr),
      onSuccess: (exitCode) => exitCode,
    });
  });

export const runRunnerLifecycle = async (
  rawOptions: Partial<RunnerLifecycleOptions> = {}
): Promise<number> =>
  await runValidatedRunnerCommand(
    runnerLifecycleOptionsSchema,
    rawOptions,
    runRunnerLifecycleEffect
  );
