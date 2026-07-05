import { existsSync, readFileSync } from "node:fs";

import { Context, Effect, Layer, Schedule } from "effect";
import { execa } from "execa";
import type { z } from "zod";

import { prepareOpencodeCredentials } from "../../credentials/runner";
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

const TERMINAL_FLUSH_RETRY_LIMIT = 60;
const TERMINAL_FLUSH_RETRY_DELAY = "1 second";
const TERMINAL_FLUSH_TIMEOUT = "60 seconds";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface RunnerCommandEventSinkOptions {
  fetch?: FetchLike;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
}

export const createRunnerCommandEventSink = ({
  fetch,
  payload,
}: RunnerCommandEventSinkOptions): ReturnType<typeof createRunnerEventSink> => {
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
};

const terminalFlushRetrySchedule = () =>
  Schedule.spaced(TERMINAL_FLUSH_RETRY_DELAY).pipe(
    Schedule.both(Schedule.recurs(TERMINAL_FLUSH_RETRY_LIMIT))
  );

const flushSinkWithTerminalRetry = (
  flushSink: (sink: FlushableSink) => Effect.Effect<void, unknown>,
  sink: FlushableSink
): Effect.Effect<void, unknown> =>
  flushSink(sink).pipe(
    Effect.retry(terminalFlushRetrySchedule()),
    Effect.timeout(TERMINAL_FLUSH_TIMEOUT)
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class RunnerCommandIoService extends Context.Service<
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
    readonly prepareOpencodeCredentials: () => Effect.Effect<
      ReturnType<typeof prepareOpencodeCredentials>,
      unknown
    >;
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
>()("RunnerCommandIoService") {}

const flushRunnerCommandSink = (
  sink: FlushableSink,
  reportError: (message: string) => void
): Effect.Effect<void, never, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    const result = yield* Effect.result(
      flushSinkWithTerminalRetry(io.flushSink, sink)
    );
    if (result._tag === "Success") {
      return;
    }
    reportError(errorMessage(result.failure));
  });

export const RunnerCommandIoServiceLive = Layer.succeed(
  RunnerCommandIoService,
  {
    commitAndPushNodeRef: (options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => await commitAndPushNodeRef(options),
      }),
    exists: (path) =>
      Effect.try({
        catch: (error) => error,
        try: () => existsSync(path),
      }),
    flushSink: (sink) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await sink.flush();
        },
      }),
    mergeDependencyRefs: (options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await mergeDependencyRefs(options);
        },
      }),
    prepareOpencodeCredentials: () =>
      Effect.try({
        catch: (error) => error,
        try: () => prepareOpencodeCredentials(),
      }),
    prepareRunnerGitWorkspace: (payload, options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => await prepareRunnerGitWorkspace(payload, options),
      }),
    promoteFinalRef: (options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => await promoteFinalRef(options),
      }),
    readText: (path) =>
      Effect.try({
        catch: (error) => error,
        try: () => readFileSync(path, "utf-8"),
      }),
    runScheduledWorkflowTask: (options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => await runScheduledWorkflowTask(options),
      }),
    runSetupCommand: (command, args, options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () =>
          await execa(command, args, {
            cwd: options.cwd,
            env: options.env,
            reject: false,
          }),
      }),
  }
);

const EXIT_VALIDATION = 64;

export interface OutputStream {
  write(chunk: string | Uint8Array): boolean;
}

export const isOutputStream = (value: unknown): value is OutputStream =>
  typeof value === "object" &&
  value !== null &&
  "write" in value &&
  typeof value.write === "function";

export const flushAndReport = (
  sink: FlushableSink,
  stderr: OutputStream
): Effect.Effect<void, never, RunnerCommandIoService> =>
  flushRunnerCommandSink(sink, (message) =>
    stderr.write(`runner event flush failed: ${message}\n`)
  );

// Shared validate-then-run boundary for the runner-command facades: parse the
// raw options, write a validation error to stderr (exit 64), otherwise run the
// command's Effect under the live IO layer. Keeps the exit-code contract in one
// place so finalize/lifecycle don't duplicate it.
export const runValidatedRunnerCommand = async <O>(
  schema: z.ZodType<O>,
  rawOptions: { stderr?: OutputStream },
  toEffect: (
    options: O,
    stderr: OutputStream
  ) => Effect.Effect<number, never, RunnerCommandIoService>
): Promise<number> => {
  const parsed = schema.safeParse(rawOptions);
  const stderr = rawOptions.stderr ?? process.stderr;
  if (parsed.success) {
    return await Effect.runPromise(
      Effect.provide(toEffect(parsed.data, stderr), RunnerCommandIoServiceLive)
    );
  }
  stderr.write(`${parsed.error.message}\n`);
  return EXIT_VALIDATION;
};
