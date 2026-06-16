import { Effect } from "effect";
import { z } from "zod";
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
    const { context, sink } =
      yield* createRunnerLifecycleContextEffect(options);
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
    Effect.catchAll((error) =>
      Effect.sync(() => lifecycleErrorExitCode(error, stderr))
    )
  );
}

function lifecycleErrorExitCode(error: unknown, stderr: OutputStream) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  return error instanceof z.ZodError ? EXIT_VALIDATION : EXIT_STARTUP;
}
