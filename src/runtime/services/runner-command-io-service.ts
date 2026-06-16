import { existsSync, readFileSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { execa } from "execa";
import type { z } from "zod";
import { runScheduledWorkflowTask } from "../../pipeline-runtime";
import {
  commitAndPushNodeRef,
  mergeDependencyRefs,
  prepareRunnerGitWorkspace,
  promoteFinalRef,
} from "../../run-state/git-refs";
import type { parseRunnerCommandPayload } from "../../runner-command-contract";
import { resolveRunnerEventSinkAuthToken } from "../../runner-command-contract";
import { createRunnerEventSink } from "../../runner-event-sink";

interface FlushableSink {
  flush: () => Promise<void>;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface RunnerCommandEventSinkOptions {
  fetch?: FetchLike;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
}

export function createRunnerCommandEventSink({
  fetch,
  payload,
}: RunnerCommandEventSinkOptions): ReturnType<typeof createRunnerEventSink> {
  const authToken = resolveRunnerEventSinkAuthToken({
    authTokenFile: payload.events.authTokenFile,
  });
  return createRunnerEventSink({
    authHeader: payload.events.authHeader,
    authToken,
    fetch,
    runId: payload.run.id,
    url: payload.events.url,
  });
}

function flushRunnerCommandSink(
  sink: FlushableSink,
  reportError: (message: string) => void
): Effect.Effect<void, never, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    const result = yield* Effect.either(io.flushSink(sink));
    if (result._tag === "Right") {
      return;
    }
    reportError(errorMessage(result.left));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RunnerCommandIoService extends Context.Tag(
  "RunnerCommandIoService"
)<
  RunnerCommandIoService,
  {
    readonly commitAndPushNodeRef: (
      options: Parameters<typeof commitAndPushNodeRef>[0]
    ) => Effect.Effect<void, unknown>;
    readonly exists: (path: string) => Effect.Effect<boolean, unknown>;
    readonly flushSink: (sink: FlushableSink) => Effect.Effect<void, unknown>;
    readonly mergeDependencyRefs: (
      options: Parameters<typeof mergeDependencyRefs>[0]
    ) => Effect.Effect<void, unknown>;
    readonly prepareRunnerGitWorkspace: (
      payload: Parameters<typeof prepareRunnerGitWorkspace>[0],
      options: Parameters<typeof prepareRunnerGitWorkspace>[1]
    ) => Effect.Effect<string, unknown>;
    readonly promoteFinalRef: (
      options: Parameters<typeof promoteFinalRef>[0]
    ) => Effect.Effect<void, unknown>;
    readonly readText: (path: string) => Effect.Effect<string, unknown>;
    readonly runScheduledWorkflowTask: (
      options: Parameters<typeof runScheduledWorkflowTask>[0]
    ) => Effect.Effect<
      Awaited<ReturnType<typeof runScheduledWorkflowTask>>,
      unknown
    >;
    readonly runSetupCommand: (
      command: string,
      args: readonly string[],
      options: { cwd: string; env: Record<string, string | undefined> }
    ) => Effect.Effect<Awaited<ReturnType<typeof execa>>, unknown>;
  }
>() {}

export const RunnerCommandIoServiceLive = Layer.succeed(
  RunnerCommandIoService,
  {
    commitAndPushNodeRef: (options) =>
      Effect.tryPromise({
        try: () => commitAndPushNodeRef(options),
        catch: (error) => error,
      }),
    exists: (path) =>
      Effect.try({
        try: () => existsSync(path),
        catch: (error) => error,
      }),
    flushSink: (sink) =>
      Effect.tryPromise({
        try: () => sink.flush(),
        catch: (error) => error,
      }),
    mergeDependencyRefs: (options) =>
      Effect.tryPromise({
        try: () => mergeDependencyRefs(options),
        catch: (error) => error,
      }),
    prepareRunnerGitWorkspace: (payload, options) =>
      Effect.tryPromise({
        try: () => prepareRunnerGitWorkspace(payload, options),
        catch: (error) => error,
      }),
    promoteFinalRef: (options) =>
      Effect.tryPromise({
        try: () => promoteFinalRef(options),
        catch: (error) => error,
      }),
    readText: (path) =>
      Effect.try({
        try: () => readFileSync(path, "utf8"),
        catch: (error) => error,
      }),
    runScheduledWorkflowTask: (options) =>
      Effect.tryPromise({
        try: () => runScheduledWorkflowTask(options),
        catch: (error) => error,
      }),
    runSetupCommand: (command, args, options) =>
      Effect.tryPromise({
        try: () =>
          execa(command, args, {
            cwd: options.cwd,
            env: options.env,
            reject: false,
          }),
        catch: (error) => error,
      }),
  }
);

const EXIT_VALIDATION = 64;

export interface OutputStream {
  write(chunk: string | Uint8Array): boolean;
}

export function isOutputStream(value: unknown): value is OutputStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "write" in value &&
    typeof value.write === "function"
  );
}

export function flushAndReport(
  sink: FlushableSink,
  stderr: OutputStream
): Effect.Effect<void, never, RunnerCommandIoService> {
  return flushRunnerCommandSink(sink, (message) =>
    stderr.write(`runner event flush failed: ${message}\n`)
  );
}

// Shared validate-then-run boundary for the runner-command facades: parse the
// raw options, write a validation error to stderr (exit 64), otherwise run the
// command's Effect under the live IO layer. Keeps the exit-code contract in one
// place so finalize/lifecycle don't duplicate it.
export function runValidatedRunnerCommand<O>(
  schema: z.ZodType<O>,
  rawOptions: { stderr?: OutputStream },
  toEffect: (
    options: O,
    stderr: OutputStream
  ) => Effect.Effect<number, never, RunnerCommandIoService>
): Promise<number> {
  const parsed = schema.safeParse(rawOptions);
  const stderr = rawOptions.stderr ?? process.stderr;
  if (parsed.success) {
    return Effect.runPromise(
      Effect.provide(toEffect(parsed.data, stderr), RunnerCommandIoServiceLive)
    );
  }
  stderr.write(`${parsed.error.message}\n`);
  return Promise.resolve(EXIT_VALIDATION);
}
