import { Effect } from "effect";
import { z } from "zod";
import { loadMokaDbUrl } from "../moka-global-config";
import {
  type CreateRunRequest,
  resolveRunControlStore,
} from "../run-control/run-control-store";
import {
  buildRemoteRunCreateRequest,
  type RemoteRunRecordOptions,
} from "../run-control/run-record";
import {
  emitWorkflowPlanned,
  emitWorkflowStarted,
} from "../runtime/events/events";
import { dispatchHooks } from "../runtime/hooks";
import {
  flushAndReport,
  isOutputStream,
  type OutputStream,
  type RunnerCommandIoService,
  runValidatedRunnerCommand,
} from "../runtime/services/runner-command-io-service";
import { runWorkflowStartLifecycle } from "../runtime/workflow-lifecycle";
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

const runnerLifecycleOptionsSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    fetch: z
      .custom<FetchLike>((value) => typeof value === "function")
      .optional(),
    payloadFile: z.string().min(1),
    phase: z.literal("workflow.start"),
    scheduleFile: z.string().min(1),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    upsertRunRecord: z
      .custom<LifecycleUpsertRunRecord>((value) => typeof value === "function")
      .optional(),
  })
  .strict();

export type RunnerLifecycleOptions = z.input<
  typeof runnerLifecycleOptionsSchema
>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

export function runRunnerLifecycle(
  rawOptions: Partial<RunnerLifecycleOptions> = {}
): Promise<number> {
  return runValidatedRunnerCommand(
    runnerLifecycleOptionsSchema,
    rawOptions,
    runRunnerLifecycleEffect
  );
}

function runRunnerLifecycleEffect(
  options: RunnerLifecycleOptions,
  stderr: OutputStream
): Effect.Effect<number, never, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const { compiled, context, payload, scheduleYaml, sink, worktreePath } =
      yield* createRunnerLifecycleContextEffect(options);

    // PIPE-94.5: upsert the run record (idempotent floor — runs even when the
    // submit-side upsert (PIPE-94.4) was skipped due to absent db.url or
    // outage). The shared builder compiles the real node list from the same
    // schedule + config the submit path uses, so first-writer-wins is lossless.
    yield* upsertLifecycleRunRecordEffect(
      {
        config: compiled.config,
        runId: payload.run.id,
        scheduleYaml,
        worktreePath,
      },
      options.upsertRunRecord,
      stderr
    );

    const failure = yield* Effect.tryPromise({
      try: () =>
        runWorkflowStartLifecycle({
          emitWorkflowPlanned: () => emitWorkflowPlanned(context),
          emitWorkflowStarted: () => emitWorkflowStarted(context),
          runWorkflowHook: (event) => dispatchHooks(context, event),
        }),
      catch: (error) => error,
    });
    yield* flushAndReport(sink, stderr);
    return failure ? EXIT_FAIL : EXIT_PASS;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => lifecycleErrorExitCode(error, stderr))
    )
  );
}

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
function upsertLifecycleRunRecordEffect(
  options: RemoteRunRecordOptions,
  upsertOverride: LifecycleUpsertRunRecord | undefined,
  stderr: OutputStream
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const write = yield* resolveLifecycleRunRecordWriter(
      options,
      upsertOverride,
      stderr
    );
    if (write === undefined) {
      return;
    }
    // Effect.try keeps a schedule-compile throw in the typed error channel so
    // the catch below logs it rather than crashing workflow.start as a defect.
    const request = yield* Effect.try({
      try: () => buildRemoteRunCreateRequest(options),
      catch: (error) => error,
    });
    yield* write(request);
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => logUpsertError(stderr, options.runId, error))
    )
  );
}

type LifecycleRunRecordWriter = (
  request: CreateRunRequest
) => Effect.Effect<unknown, unknown>;

/**
 * Select the createRun write target: the injected override (test/custom seam),
 * or the db.url-resolved run-control store. Returns undefined — and logs the
 * deliberate skip — when no override is set and db.url is absent (no durable
 * substrate configured for this pod).
 */
function resolveLifecycleRunRecordWriter(
  options: RemoteRunRecordOptions,
  upsertOverride: LifecycleUpsertRunRecord | undefined,
  stderr: OutputStream
): Effect.Effect<LifecycleRunRecordWriter | undefined, never> {
  return Effect.sync(() => {
    if (upsertOverride !== undefined) {
      return (request: CreateRunRequest) =>
        Effect.tryPromise({
          try: () => upsertOverride(request),
          catch: (error) => error,
        });
    }
    const dbUrl = loadMokaDbUrl();
    if (dbUrl === undefined) {
      stderr.write(
        `runner-lifecycle: db.url not configured — skipping createRun for run ${options.runId}\n`
      );
      return;
    }
    return (request: CreateRunRequest) =>
      Effect.scoped(
        resolveRunControlStore(dbUrl, options.worktreePath ?? "").pipe(
          Effect.flatMap((store) => store.createRun(request))
        )
      );
  });
}

function logUpsertError(
  stderr: OutputStream,
  runId: string,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(
    `runner-lifecycle: createRun failed — run ${runId} will still execute: ${message}\n`
  );
}

function lifecycleErrorExitCode(error: unknown, stderr: OutputStream) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  return error instanceof z.ZodError ? EXIT_VALIDATION : EXIT_STARTUP;
}
