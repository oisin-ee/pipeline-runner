import { Effect, Option } from "effect";

import type { PipelineRuntimeEvent } from "./pipeline-runtime";
import { mapRuntimeEventToRunnerEventRecords as mapRuntimeEventRecords } from "./runner-command-contract";
import type { RunnerEventRecord } from "./runner-command-contract";
import {
  RunnerEventSinkHttpService,
  RunnerEventSinkHttpServiceLive,
} from "./runtime/services/runner-event-sink-http-service";
import type {
  RunnerEventSinkFetch,
  RunnerEventSinkPostBatchRequest,
} from "./runtime/services/runner-event-sink-http-service";

type FetchLike = RunnerEventSinkFetch;

export interface RunnerEventSinkOptions {
  authHeader?: string;
  authToken: string;
  batchSize?: number;
  fetch?: FetchLike;
  maxRetries?: number;
  now?: () => Date;
  retryDelayMs?: number;
  runId: string;
  url: string;
}

export interface RunnerEventSink {
  fail: () => Promise<void>;
  flush: () => Promise<void>;
  recordCancellation: (workflowId: string) => void;
  recordFinalResult: (
    outcome: "CANCELLED" | "FAIL" | "PASS",
    workflowId: string
  ) => void;
  recordRunnerCommandPhase: (
    phase: string,
    message: string,
    output?: Record<string, unknown>
  ) => void;
  recordRuntimeEvent: (event: PipelineRuntimeEvent) => void;
  recordSchemaValidationFailure: (
    message: string,
    issues: { message: string; path: string }[],
    workflowId: string
  ) => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

export const RUNNER_EVENT_SINK_RETRY_POLICY = {
  maxRetries: DEFAULT_MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
} as const;

const hasQueuedEvents = (queue: RunnerEventRecord[]): boolean =>
  queue.length > 0;

const positiveOrDefault = (
  value: Option.Option<number>,
  fallback: number
): number =>
  Math.max(
    1,
    Option.getOrElse(value, () => fallback)
  );

const nonNegativeOrDefault = (
  value: Option.Option<number>,
  fallback: number
): number =>
  Math.max(
    0,
    Option.getOrElse(value, () => fallback)
  );

const resolveFetch = (fetchImpl: Option.Option<FetchLike>): FetchLike => {
  if (Option.isSome(fetchImpl)) {
    return fetchImpl.value;
  }
  if (!Object.hasOwn(globalThis, "fetch")) {
    throw new Error("Runner event sink requires fetch support");
  }
  return globalThis.fetch.bind(globalThis);
};

const assertAuthToken = (authToken: string): void => {
  if (!authToken.trim()) {
    throw new Error("Runner event sink requires an auth token");
  }
};

const postBatchRequest = (
  options: RunnerEventSinkOptions,
  fetchImpl: FetchLike,
  events: RunnerEventRecord[]
): RunnerEventSinkPostBatchRequest => ({
  authHeader: options.authHeader,
  authToken: options.authToken,
  events,
  fetch: fetchImpl,
  maxRetries: nonNegativeOrDefault(
    Option.fromUndefinedOr(options.maxRetries),
    RUNNER_EVENT_SINK_RETRY_POLICY.maxRetries
  ),
  retryDelayMs: nonNegativeOrDefault(
    Option.fromUndefinedOr(options.retryDelayMs),
    RUNNER_EVENT_SINK_RETRY_POLICY.retryDelayMs
  ),
  url: options.url,
});

const timestamp = (now: RunnerEventSinkOptions["now"]): string =>
  (now === undefined ? new Date() : now()).toISOString();

/*
 * Keep the custom event sink HTTP batching and retry path. Kubernetes events are
 * useful for humans, but they are not the automation contract; the console needs
 * ordered semantic runner records, authenticated batches, and deterministic retry
 * failure handling.
 */

export const createRunnerEventSink = (
  options: RunnerEventSinkOptions
): RunnerEventSink => {
  const batchSize = positiveOrDefault(
    Option.fromUndefinedOr(options.batchSize),
    DEFAULT_BATCH_SIZE
  );
  const fetchImpl = resolveFetch(Option.fromUndefinedOr(options.fetch));
  assertAuthToken(options.authToken);
  const queue: RunnerEventRecord[] = [];
  // PIPE-92.1: intentionally not replaced by the serialized write queue. The
  // sink owns batch mutation/retry semantics: failed flushes leave records queued
  // for a later retry, while background scheduled failures are swallowed.
  let flushChain: Promise<void> = Promise.resolve();
  let nextSequence = 1;
  let scheduledFlush = false;

  const nextEnvelope = (): Pick<
    RunnerEventRecord,
    "at" | "runId" | "sequence"
  > => {
    const sequence = nextSequence;
    nextSequence += 1;
    return {
      at: timestamp(options.now),
      runId: options.runId,
      sequence,
    };
  };

  const flushQueueEffect = (): Effect.Effect<
    void,
    Error,
    RunnerEventSinkHttpService
  > =>
    Effect.gen(function* flushQueueEffect() {
      const service = yield* RunnerEventSinkHttpService;
      while (hasQueuedEvents(queue)) {
        const batch = queue.slice(0, batchSize);
        yield* service.postBatch(postBatchRequest(options, fetchImpl, batch));
        queue.splice(0, batch.length);
      }
    });

  const runFlush = async (): Promise<void> => {
    await Effect.runPromise(
      Effect.provide(flushQueueEffect(), RunnerEventSinkHttpServiceLive)
    );
  };

  const runSerializedFlush = async (): Promise<void> => {
    const nextFlush = flushChain.then(runFlush, runFlush);
    flushChain = nextFlush.catch(() => {
      /* empty */
    });
    await nextFlush;
  };

  const scheduleFlush = (): void => {
    if (scheduledFlush) {
      return;
    }

    scheduledFlush = true;
    queueMicrotask(() => {
      scheduledFlush = false;
      runSerializedFlush().catch(() => {
        /* empty */
      });
    });
  };

  const recordRuntimeEvent = (event: PipelineRuntimeEvent): void => {
    const records = mapRuntimeEventRecords(event, {
      runId: options.runId,
      sequence: nextSequence,
      timestamp: timestamp(options.now),
    });
    queue.push(...records);
    nextSequence += records.length;
    scheduleFlush();
  };

  const flush = async (): Promise<void> => {
    await runSerializedFlush();
  };

  return {
    fail: flush,
    flush,
    recordCancellation(workflowId) {
      queue.push({
        ...nextEnvelope(),
        log: {
          level: "warn",
          message:
            "Runner received a termination signal and cancelled the run.",
        },
        type: "run.cancelled",
      });
      queue.push({
        ...nextEnvelope(),
        finalResult: {
          outcome: "CANCELLED",
          workflowId,
        },
        type: "workflow.finish",
      });
      scheduleFlush();
    },
    recordFinalResult(outcome, workflowId) {
      recordRuntimeEvent({ outcome, type: "workflow.finish", workflowId });
    },
    recordRunnerCommandPhase(phase, message, output) {
      queue.push({
        ...nextEnvelope(),
        log: {
          level: "info",
          message,
          output: { phase, ...output },
        },
        type: "runner.command.phase",
      });
      scheduleFlush();
    },
    recordRuntimeEvent,
    recordSchemaValidationFailure(message, issues, workflowId) {
      queue.push({
        ...nextEnvelope(),
        log: {
          level: "warn",
          message: `Runner payload schema validation failed: ${message}`,
          output: { issues },
          workflowId,
        },
        type: "runner.schema.validation",
      });
      queue.push({
        ...nextEnvelope(),
        finalResult: {
          outcome: "FAIL",
          workflowId,
        },
        type: "workflow.finish",
      });
      scheduleFlush();
    },
  };
};
