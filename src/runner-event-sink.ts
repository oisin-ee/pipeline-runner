import { Effect } from "effect";
import type { PipelineRuntimeEvent } from "./pipeline-runtime";
import {
  mapRuntimeEventToRunnerEventRecords as mapRuntimeEventRecords,
  type RunnerEventRecord,
} from "./runner-command-contract";
import {
  type RunnerEventSinkFetch,
  RunnerEventSinkHttpService,
  RunnerEventSinkHttpServiceLive,
  type RunnerEventSinkPostBatchRequest,
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
    issues: Array<{ message: string; path: string }>,
    workflowId: string
  ) => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_RETRY_DELAY_MS = 250;

/*
 * Keep the custom event sink HTTP batching and retry path. Kubernetes events are
 * useful for humans, but they are not the automation contract; the console needs
 * ordered semantic runner records, authenticated batches, and deterministic retry
 * failure handling.
 */

export function createRunnerEventSink(
  options: RunnerEventSinkOptions
): RunnerEventSink {
  const batchSize = positiveOrDefault(options.batchSize, DEFAULT_BATCH_SIZE);
  const fetchImpl = resolveFetch(options.fetch);
  assertAuthToken(options.authToken);
  const queue: RunnerEventRecord[] = [];
  let flushChain: Promise<void> = Promise.resolve();
  let nextSequence = 1;
  let scheduledFlush = false;

  const nextEnvelope = (): Pick<RunnerEventRecord, "at" | "sequence"> => {
    const sequence = nextSequence;
    nextSequence += 1;
    return {
      at: timestamp(options.now),
      sequence,
    };
  };

  const flushQueueEffect = (): Effect.Effect<
    void,
    Error,
    RunnerEventSinkHttpService
  > =>
    Effect.gen(function* () {
      const service = yield* RunnerEventSinkHttpService;
      while (hasQueuedEvents(queue)) {
        const batch = queue.slice(0, batchSize);
        yield* service.postBatch(postBatchRequest(options, fetchImpl, batch));
        queue.splice(0, batch.length);
      }
    });

  const runFlush = (): Promise<void> =>
    Effect.runPromise(
      Effect.provide(flushQueueEffect(), RunnerEventSinkHttpServiceLive)
    );

  const runSerializedFlush = (): Promise<void> => {
    const nextFlush = flushChain.then(runFlush, runFlush);
    flushChain = nextFlush.catch(() => undefined);
    return nextFlush;
  };

  const scheduleFlush = (): void => {
    if (scheduledFlush) {
      return;
    }

    scheduledFlush = true;
    queueMicrotask(() => {
      scheduledFlush = false;
      runSerializedFlush().catch(() => undefined);
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

  const flush = (): Promise<void> => runSerializedFlush();

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
}

function hasQueuedEvents(queue: RunnerEventRecord[]): boolean {
  return queue.length > 0;
}

function positiveOrDefault(
  value: number | undefined,
  fallback: number
): number {
  return Math.max(1, value ?? fallback);
}

function nonNegativeOrDefault(
  value: number | undefined,
  fallback: number
): number {
  return Math.max(0, value ?? fallback);
}

function resolveFetch(fetchImpl: FetchLike | undefined): FetchLike {
  const resolved = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!resolved) {
    throw new Error("Runner event sink requires fetch support");
  }
  return resolved;
}

function assertAuthToken(authToken: string): void {
  if (!authToken.trim()) {
    throw new Error("Runner event sink requires an auth token");
  }
}

function postBatchRequest(
  options: RunnerEventSinkOptions,
  fetchImpl: FetchLike,
  events: RunnerEventRecord[]
): RunnerEventSinkPostBatchRequest {
  return {
    authHeader: options.authHeader,
    authToken: options.authToken,
    events,
    fetch: fetchImpl,
    maxRetries: nonNegativeOrDefault(options.maxRetries, DEFAULT_MAX_RETRIES),
    retryDelayMs: nonNegativeOrDefault(
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS
    ),
    url: options.url,
  };
}

function timestamp(now: RunnerEventSinkOptions["now"]): string {
  return (now?.() ?? new Date()).toISOString();
}
