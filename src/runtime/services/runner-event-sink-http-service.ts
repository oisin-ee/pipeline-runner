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
    super({ message, status });
  }
}

const RETRYABLE_STATUS_CODES = [
  408, 429, 500, 501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511,
];
const REQUEST_TIMEOUT_MS = 10_000;

const authHeaderName = (request: RunnerEventSinkPostBatchRequest): string =>
  request.authHeader ?? "Authorization";

const formatHttpErrorData = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }
  return data === undefined ? "" : JSON.stringify(data);
};

const httpErrorData = (error: unknown): string => {
  const data = isHTTPError(error) ? error.data : undefined;
  return formatHttpErrorData(data);
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const toHttpError = (error: unknown): EventSinkHttpError => {
  const data = httpErrorData(error);
  const status = isHTTPError(error) ? error.response.status : 0;
  return new EventSinkHttpError(
    status,
    `Event sink responded with ${status}${data ? `: ${data}` : ""}`
  );
};

const mapPostError = (error: unknown): Error =>
  isHTTPError(error) ? toHttpError(error) : toError(error);

const kyFetchAdapter =
  (fetchImpl: RunnerEventSinkFetch): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    return await fetchImpl(request.url, {
      body: await request.clone().text(),
      headers: request.headers,
      method: request.method,
      signal: request.signal,
    });
  };

const totalTimeoutMs = (request: RunnerEventSinkPostBatchRequest): number => {
  const attempts = request.maxRetries + 1;
  return (
    attempts * REQUEST_TIMEOUT_MS + request.maxRetries * request.retryDelayMs
  );
};

const postBatch = (
  request: RunnerEventSinkPostBatchRequest
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    catch: mapPostError,
    try: async () => {
      await ky
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
          timeout: REQUEST_TIMEOUT_MS,
          totalTimeout: totalTimeoutMs(request),
        })
        .then(() => {
          /* empty */
        });
    },
  });

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
