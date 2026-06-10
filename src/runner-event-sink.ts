import ky, { isHTTPError } from "ky";
import type { PipelineRuntimeEvent } from "./pipeline-runtime";
import {
  mapRuntimeEventToRunnerEventRecords as mapRuntimeEventRecords,
  type RunnerEventRecord,
} from "./runner-command-contract";

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
const RETRYABLE_STATUS_CODES = [
  408, 429, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511,
];

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

  const flushQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      await postBatch(options, fetchImpl, batch);
      queue.splice(0, batch.length);
    }
  };

  const runSerializedFlush = (): Promise<void> => {
    const nextFlush = flushChain.then(flushQueue, flushQueue);
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
  try {
    await ky.post(options.url, {
      fetch: kyFetchAdapter(fetchImpl),
      headers: {
        [options.authHeader ?? "Authorization"]: `Bearer ${options.authToken}`,
      },
      json: { events },
      retry: {
        delay: () => retryDelayMs,
        limit: maxRetries,
        methods: ["post"],
        retryOnTimeout: true,
        statusCodes: RETRYABLE_STATUS_CODES,
      },
    });
  } catch (err) {
    if (isHTTPError(err)) {
      let data = "";
      if (typeof err.data === "string") {
        data = err.data;
      } else if (err.data !== undefined) {
        data = JSON.stringify(err.data);
      }
      throw new EventSinkHttpError(
        err.response.status,
        `Event sink responded with ${err.response.status}${data ? `: ${data}` : ""}`
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function kyFetchAdapter(fetchImpl: FetchLike): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    return fetchImpl(request.url, {
      body: await request.clone().text(),
      headers: request.headers,
      method: request.method,
      signal: request.signal,
    });
  };
}

function timestamp(now: RunnerEventSinkOptions["now"]): string {
  return (now?.() ?? new Date()).toISOString();
}
