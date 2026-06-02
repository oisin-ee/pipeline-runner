import type { PipelineRuntimeEvent } from "./pipeline-runtime.js";
import {
  mapRuntimeEventToRunnerEventRecords as mapRuntimeEventRecords,
  type RunnerEventRecord,
} from "./runner-job-contract.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

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
  recordRuntimeEvent: (event: PipelineRuntimeEvent) => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_RETRY_DELAY_MS = 250;
const AUTH_FAILURE_RE = /Event sink responded with (401|403)/i;

class EventSinkHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EventSinkHttpError";
    this.status = status;
  }
}

export function createRunnerEventSink(
  options: RunnerEventSinkOptions
): RunnerEventSink {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("Runner event sink requires fetch support");
  }
  if (!options.authToken.trim()) {
    throw new Error("Runner event sink requires an auth token");
  }

  const queue: RunnerEventRecord[] = [];
  let nextSequence = 1;

  const nextEnvelope = (): Pick<RunnerEventRecord, "at" | "sequence"> => {
    const sequence = nextSequence;
    nextSequence += 1;
    return {
      at: timestamp(options.now),
      sequence,
    };
  };

  const recordRuntimeEvent = (event: PipelineRuntimeEvent): void => {
    const records = mapRuntimeEventRecords(event, {
      runId: options.runId,
      sequence: nextSequence,
      timestamp: timestamp(options.now),
    });
    queue.push(...records);
    nextSequence += records.length;
  };

  const flush = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      await postBatch(options, fetchImpl, batch);
      queue.splice(0, batch.length);
    }
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
    },
    recordFinalResult(outcome, workflowId) {
      recordRuntimeEvent({ outcome, type: "workflow.finish", workflowId });
    },
    recordRuntimeEvent,
  };
}

async function postBatch(
  options: RunnerEventSinkOptions,
  fetchImpl: FetchLike,
  events: RunnerEventRecord[]
): Promise<void> {
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  );
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await postBatchAttempt(options, fetchImpl, events);
    if (result === null) {
      return;
    }
    if (shouldStopRetrying(result, attempt, maxRetries)) {
      throw result;
    }
    lastError = result;

    if (retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new Error("Event sink flush failed");
}

async function postBatchAttempt(
  options: RunnerEventSinkOptions,
  fetchImpl: FetchLike,
  events: RunnerEventRecord[]
): Promise<Error | null> {
  try {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: {
        [options.authHeader ?? "Authorization"]: `Bearer ${options.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events }),
    });

    if (response.ok) {
      return null;
    }

    const message = await response.text();
    return new EventSinkHttpError(
      response.status,
      `Event sink responded with ${response.status}${message ? `: ${message}` : ""}`
    );
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function shouldStopRetrying(
  error: Error,
  attempt: number,
  maxRetries: number
): boolean {
  return (
    AUTH_FAILURE_RE.test(error.message) ||
    (error instanceof EventSinkHttpError && !isRetryableStatus(error.status)) ||
    attempt === maxRetries
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp(now: RunnerEventSinkOptions["now"]): string {
  return (now?.() ?? new Date()).toISOString();
}
