import { Context, Data, Effect, Layer } from "effect";
import ky, { isHTTPError } from "ky";
import type { RunnerEventRecord } from "../../runner-command-contract";

export type RunnerEventSinkFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface RunnerEventSinkPostBatchRequest {
  readonly authHeader?: string;
  readonly authToken: string;
  readonly events: RunnerEventRecord[];
  readonly fetch: RunnerEventSinkFetch;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly url: string;
}

class EventSinkHttpError extends Data.TaggedError("EventSinkHttpError")<{
  readonly status: number;
  readonly message: string;
}> {
  constructor(status: number, message: string) {
    super({ status, message });
  }
}

const RETRYABLE_STATUS_CODES = [
  408, 429, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511,
];

function authHeaderName(request: RunnerEventSinkPostBatchRequest): string {
  return request.authHeader ?? "Authorization";
}

function httpErrorData(error: unknown): string {
  const data = isHTTPError(error) ? error.data : undefined;
  return formatHttpErrorData(data);
}

function formatHttpErrorData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  return data === undefined ? "" : JSON.stringify(data);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toHttpError(error: unknown): EventSinkHttpError {
  const data = httpErrorData(error);
  const status = isHTTPError(error) ? error.response.status : 0;
  return new EventSinkHttpError(
    status,
    `Event sink responded with ${status}${data ? `: ${data}` : ""}`
  );
}

function mapPostError(error: unknown): Error {
  return isHTTPError(error) ? toHttpError(error) : toError(error);
}

function kyFetchAdapter(fetchImpl: RunnerEventSinkFetch): typeof fetch {
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

function postBatch(
  request: RunnerEventSinkPostBatchRequest
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    catch: mapPostError,
    try: () =>
      ky
        .post(request.url, {
          fetch: kyFetchAdapter(request.fetch),
          headers: {
            [authHeaderName(request)]: `Bearer ${request.authToken}`,
          },
          json: { events: request.events },
          retry: {
            delay: () => request.retryDelayMs,
            limit: request.maxRetries,
            methods: ["post"],
            retryOnTimeout: true,
            statusCodes: RETRYABLE_STATUS_CODES,
          },
        })
        .then(() => undefined),
  });
}

export class RunnerEventSinkHttpService extends Context.Service<
  RunnerEventSinkHttpService,
  {
    readonly postBatch: (
      request: RunnerEventSinkPostBatchRequest
    ) => Effect.Effect<void, Error>;
  }
>()("RunnerEventSinkHttpService") {}

export const RunnerEventSinkHttpServiceLive = Layer.succeed(
  RunnerEventSinkHttpService,
  { postBatch }
);
