import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk/v2";
import { Duration, Effect } from "effect";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import { isRecord } from "../safe-json";
import { EXIT_AGENT_ERROR, EXIT_INFRA, EXIT_OK } from "./exit-codes";
import { opencodeAgentName } from "./opencode-agent-name";
import {
  type OpencodeRuntimeClient,
  OpencodeSdkService,
  OpencodeSdkServiceLive,
} from "./services/opencode-sdk-service";

/**
 * Session bookkeeping shared across a run. Keyed by node id so goal-loop
 * continuation can REUSE the same opencode session for a node instead of
 * starting a cold one: createGoalContinuationLaunchPlan keeps a stable nodeId
 * ("goal-continuation" by default), so every continuation attempt hits the same
 * registry entry and the same opencode session. Reuse — not fork — is the
 * default: continuation is "keep working on the same goal with full prior
 * context", which is exactly session semantics; forking would discard the
 * in-session history we want to build on. A fresh session is only created when
 * no prior session exists for the node.
 */
export interface OpencodeSessionRegistry {
  /** node id -> opencode session id */
  sessions: Map<string, string>;
}

export function createOpencodeSessionRegistry(): OpencodeSessionRegistry {
  return { sessions: new Map() };
}

export interface OpencodeExecutorDeps {
  client: OpencodeRuntimeClient;
  /** Working directory threaded into every create/prompt request. */
  directory: string;
  /** Called with the resolved session id once known (run-state recording). */
  onSession?: (nodeId: string, sessionId: string) => void;
  registry: OpencodeSessionRegistry;
}

interface SessionDriveResult {
  assistant?: AssistantMessage;
  parts: Part[];
  sessionId: string;
}

/**
 * SDK-backed replacement for the subprocess `runLaunchPlan`. Conforms to the
 * RuntimeContext.executor seam so agent-node never learns the transport.
 */
export function createOpencodeExecutor(deps: OpencodeExecutorDeps) {
  return async function execute(
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions = {}
  ): Promise<AgentResult> {
    // Thread the caller's AbortSignal into the Effect runtime so transient-retry
    // backoff sleeps are interruptible on cancellation rather than uncancellable.
    return await Effect.runPromise(
      Effect.provide(
        executeOpencodeEffect(deps, plan, options),
        OpencodeSdkServiceLive
      ),
      options.signal ? { signal: options.signal } : undefined
    );
  };
}

function executeOpencodeEffect(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<AgentResult, Error, OpencodeSdkService> {
  return Effect.gen(function* () {
    yield* validateOpencodePlan(plan);
    return yield* executeOpencodeSession(deps, plan, options);
  });
}

function executeOpencodeSession(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<AgentResult, never, OpencodeSdkService> {
  return Effect.gen(function* () {
    const drive = yield* driveSession(deps, plan, options);
    return successResult(plan, drive);
  }).pipe(
    withAgentTimeout(plan),
    Effect.catchAll((error) => Effect.succeed(failureResult(plan, error)))
  );
}

/*
 * Bound each agent attempt by a wall-clock budget (plan.timeoutMs, from
 * actor.timeout_ms / PIPELINE_AGENT_TIMEOUT_MS). A stalled opencode session —
 * one that streams nothing and never completes — would otherwise hang until the
 * pod's activeDeadlineSeconds kills the whole node (observed: a model producing
 * zero output for ~60 min). Timing out as a failure routes through
 * failureResult -> EXIT_INFRA, so the agent node's model fallback advances to the
 * next model instead of burning the node on one stuck model.
 */
function withAgentTimeout(plan: RunnerLaunchPlan) {
  return <A, R>(
    effect: Effect.Effect<A, unknown, R>
  ): Effect.Effect<A, unknown, R> => {
    const timeoutMs = plan.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return effect;
    }
    return Effect.timeoutFail(effect, {
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new Error(`agent session timed out after ${timeoutMs}ms`),
    });
  };
}

function validateOpencodePlan(
  plan: RunnerLaunchPlan
): Effect.Effect<void, Error> {
  if (plan.type === "opencode") {
    return Effect.void;
  }
  return Effect.fail(
    new Error(`opencode executor cannot drive runner type '${plan.type}'`)
  );
}

// PIPE-83.4: a worktree-isolated child carries its tree in plan.cwd; fall back
// to the lease directory for normal nodes (where plan.cwd === deps.directory).
function sessionDirectory(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan
): string {
  return plan.cwd ?? deps.directory;
}

function driveSession(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<SessionDriveResult, unknown, OpencodeSdkService> {
  return Effect.gen(function* () {
    const sessionId = yield* resolveSessionId(deps, plan, options);
    recordSession(deps, plan.nodeId, sessionId);
    const stream = yield* streamEventsToOutput(deps, sessionId, plan, options);
    return yield* promptSessionResult(deps, plan, sessionId, options).pipe(
      Effect.ensuring(stopStream(stream))
    );
  });
}

function promptSessionResult(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  sessionId: string,
  options: RunnerExecutionOptions
): Effect.Effect<SessionDriveResult, unknown, OpencodeSdkService> {
  // promptSession retry is bounded to transport-class failures (fetch failed,
  // connection reset/timeout, HTTP 429/5xx) raised BEFORE the server accepts the
  // turn — the prompt was provably not accepted, so re-issuing it to the same
  // session does not duplicate an accepted message. A turn that completes and
  // then reports MessageOutputLength/Aborted never throws here (it returns on
  // data.info.error and is classified by successResult), so it is not retried.
  return retryTransientTransport(
    () =>
      Effect.gen(function* () {
        const sdk = yield* OpencodeSdkService;
        const response = yield* sdk.promptSession(
          deps.client,
          promptRequest(deps, plan, sessionId)
        );
        const data = yield* unwrapEffect(response);
        return {
          ...(data.info ? { assistant: data.info } : {}),
          parts: data.parts ?? [],
          sessionId,
        };
      }),
    { label: "session.prompt", options, plan }
  );
}

function promptRequest(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  sessionId: string
) {
  return {
    directory: sessionDirectory(deps, plan),
    sessionID: sessionId,
    ...promptBody(plan),
  };
}

function stopStream(stream: EventStreamHandle): Effect.Effect<void> {
  return Effect.tryPromise(() => stream.stop()).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void)
  );
}

function recordSession(
  deps: OpencodeExecutorDeps,
  nodeId: string,
  sessionId: string
): void {
  deps.onSession?.(nodeId, sessionId);
}

function resolveSessionId(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<string, unknown, OpencodeSdkService> {
  const existing = deps.registry.sessions.get(plan.nodeId);
  if (existing) {
    return Effect.succeed(existing);
  }
  return Effect.gen(function* () {
    // createSession retry is idempotency-safe: no session id is recorded until a
    // create succeeds, so a transient transport failure can be re-issued without
    // orphaning or duplicating a session.
    const session = yield* retryTransientTransport(
      () =>
        Effect.gen(function* () {
          const sdk = yield* OpencodeSdkService;
          const created = yield* sdk.createSession(deps.client, {
            directory: plan.cwd ?? deps.directory,
            title: `moka:${plan.nodeId}`,
          });
          return yield* unwrapEffect(created);
        }),
      { label: "session.create", options, plan }
    );
    deps.registry.sessions.set(plan.nodeId, session.id);
    return session.id;
  });
}

/**
 * Bounded retry for transient OpenCode transport failures at the SDK boundary.
 * Distinct from the node-level retry in retry.ts (which reprompts on gate
 * failures): this re-issues a single SDK call that failed to complete a round
 * trip, before the executor returns an AgentResult. `make` is re-invoked per
 * attempt so each retry issues a fresh request. Backoff sleeps are interruptible
 * via the AbortSignal threaded into Effect.runPromise.
 */
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_BASE_MS = 250;

interface TransientRetryContext {
  label: string;
  options: RunnerExecutionOptions;
  plan: RunnerLaunchPlan;
}

function retryTransientTransport<A>(
  make: () => Effect.Effect<A, unknown, OpencodeSdkService>,
  ctx: TransientRetryContext,
  attempt = 0
): Effect.Effect<A, unknown, OpencodeSdkService> {
  return make().pipe(
    Effect.catchAll((error) =>
      attempt < MAX_TRANSIENT_RETRIES && isTransientTransportError(error)
        ? scheduleTransientRetry(make, ctx, attempt, error)
        : Effect.fail(error)
    )
  );
}

function scheduleTransientRetry<A>(
  make: () => Effect.Effect<A, unknown, OpencodeSdkService>,
  ctx: TransientRetryContext,
  attempt: number,
  error: unknown
): Effect.Effect<A, unknown, OpencodeSdkService> {
  const nextAttempt = attempt + 1;
  const delay = Duration.millis(TRANSIENT_RETRY_BASE_MS * 2 ** attempt);
  return emitTransientRetry(ctx, error, nextAttempt, delay).pipe(
    Effect.zipRight(Effect.sleep(delay)),
    Effect.zipRight(retryTransientTransport(make, ctx, nextAttempt))
  );
}

function emitTransientRetry(
  ctx: TransientRetryContext,
  error: unknown,
  attempt: number,
  delay: Duration.Duration
): Effect.Effect<void> {
  return Effect.sync(() => {
    ctx.options.onOutput?.({
      chunk: `opencode ${ctx.label} transient failure: ${errorMessage(error)}; retry ${attempt}/${MAX_TRANSIENT_RETRIES} in ${Duration.toMillis(delay)}ms\n`,
      nodeId: ctx.plan.nodeId,
      stream: "stderr",
    });
  });
}

const TRANSIENT_TRANSPORT_RE =
  /fetch failed|econnreset|etimedout|enotfound|eai_again|socket hang ?up|network|connection (?:reset|closed|refused)|aborterror|operation was aborted|timed? ?out/i;

/**
 * Retry only failures that prove the turn was NOT accepted: transport errors
 * (no completed round trip) and HTTP 429/5xx rejections. Deterministic agent
 * outcomes (output-length, aborted message, schema/contract problems) and gate
 * failures are out of scope and never reach this classifier as retryable.
 */
function isTransientTransportError(error: unknown): boolean {
  if (TRANSIENT_TRANSPORT_RE.test(errorMessage(error))) {
    return true;
  }
  const status = httpStatusFromError(error);
  return status !== undefined && (status === 429 || status >= 500);
}

function numericField(container: unknown, key: string): number | undefined {
  const value = isRecord(container) ? container[key] : undefined;
  return typeof value === "number" ? value : undefined;
}

function httpStatusFromError(error: unknown): number | undefined {
  const response = isRecord(error) ? error.response : undefined;
  return (
    numericField(error, "status") ??
    numericField(error, "statusCode") ??
    numericField(response, "status")
  );
}

function unwrapEffect<T>(response: ResultTuple<T>): Effect.Effect<T, unknown> {
  return Effect.try({ catch: (error) => error, try: () => unwrap(response) });
}

// `variant` selects the opencode model variant (reasoning effort) on the prompt
// request. The opencode server (1.17.x) reads it on /session/{id}/message, but
// the SDK's request body type lags and omits it; the JSON body serializer
// forwards the field verbatim, so we declare it here and let it ride through.
function promptBody(plan: RunnerLaunchPlan): {
  agent?: string;
  model?: { modelID: string; providerID: string };
  parts: Array<{ text: string; type: "text" }>;
  variant?: string;
} {
  const prompt = promptText(plan);
  const model = parseModel(plan.model);
  const agent = plan.profileId ? opencodeAgentName(plan.profileId) : undefined;
  return {
    parts: [{ text: prompt, type: "text" }],
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(plan.variant ? { variant: plan.variant } : {}),
  };
}

const FLAGS_TAKING_VALUE = new Set(["--model", "--dir", "--file", "--format"]);

/**
 * The launch plan carries the prompt inside the CLI argv (`run <prompt>` or
 * `run <prompt> --file <ctx>`). Recover it as the trailing positional arg
 * (skipping flags and their values) so the adapter boundary is identical
 * regardless of transport.
 */
function promptText(plan: RunnerLaunchPlan): string {
  const positional = plan.args.filter(
    (arg, index) =>
      index > 0 &&
      !arg.startsWith("-") &&
      !FLAGS_TAKING_VALUE.has(plan.args[index - 1] ?? "")
  );
  return positional.at(-1) ?? "";
}

function parseModel(
  model: string | undefined
): { modelID: string; providerID: string } | undefined {
  if (!model) {
    return;
  }
  const slash = model.indexOf("/");
  if (slash === -1) {
    return;
  }
  return {
    modelID: model.slice(slash + 1),
    providerID: model.slice(0, slash),
  };
}

/**
 * Subscribe to the server event stream and forward structured SDK events into
 * the runtime output callback with NO loss of granularity relative to the old
 * stdout scraping. Returns a stop() that ends the subscription. SSE failure
 * mid-run is surfaced through onOutput (stderr) and does not, by itself, fail
 * the node: session.prompt still returns the authoritative final message, so a
 * dropped stream degrades to "less live detail" rather than a hard failure.
 */
interface EventStreamHandle {
  stop(): Promise<void>;
}

function streamEventsToOutput(
  deps: OpencodeExecutorDeps,
  sessionId: string,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<EventStreamHandle, unknown, OpencodeSdkService> {
  if (!options.onOutput) {
    return Effect.succeed({ stop: () => Promise.resolve() });
  }
  return Effect.gen(function* () {
    const sdk = yield* OpencodeSdkService;
    const subscription = yield* sdk.subscribeEvents(deps.client);
    const iterator = subscription.stream;
    const pump = Effect.runPromise(
      pumpEvents(iterator, sessionId, plan, options)
    );
    return { stop: () => stopIterator(iterator, pump) };
  });
}

function pumpEvents(
  iterator: AsyncIterator<Event>,
  sessionId: string,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<void> {
  return Effect.gen(function* () {
    let done = false;
    while (!done) {
      const next = yield* readNextEvent(iterator);
      done = next.done === true;
      if (!done) {
        forwardEvent(next.value, sessionId, plan, options);
      }
    }
  }).pipe(Effect.catchAll((error) => reportStreamDrop(error, plan, options)));
}

function readNextEvent(
  iterator: AsyncIterator<Event>
): Effect.Effect<IteratorResult<Event>, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => iterator.next(),
  });
}

function reportStreamDrop(
  error: unknown,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<void> {
  return Effect.sync(() => {
    options.onOutput?.({
      chunk: `opencode event stream dropped: ${errorMessage(error)}\n`,
      nodeId: plan.nodeId,
      stream: "stderr",
    });
  });
}

function stopIterator(
  iterator: AsyncIterator<Event>,
  pump: Promise<void>
): Promise<void> {
  return Effect.runPromise(stopIteratorEffect(iterator, pump));
}

function stopIteratorEffect(
  iterator: AsyncIterator<Event>,
  pump: Promise<void>
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* requestIteratorReturn(iterator);
    yield* Effect.tryPromise(() => pump).pipe(
      Effect.catchAll(() => Effect.void)
    );
  });
}

function requestIteratorReturn(
  iterator: AsyncIterator<Event>
): Effect.Effect<void> {
  const returnIterator = iterator.return;
  if (!returnIterator) {
    return Effect.void;
  }
  return Effect.tryPromise({
    catch: (error) => error,
    try: () => returnIterator.call(iterator, undefined),
  }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void)
  );
}

interface ForwardChunk {
  chunk: string;
  stream: "stderr" | "stdout";
}

function forwardEvent(
  event: Event,
  sessionId: string,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): void {
  const forwarded = eventChunk(event, sessionId);
  if (forwarded) {
    options.onOutput?.({
      chunk: forwarded.chunk,
      nodeId: plan.nodeId,
      stream: forwarded.stream,
    });
  }
}

function eventChunk(event: Event, sessionId: string): ForwardChunk | undefined {
  if (event.type === "message.part.updated") {
    return partChunk(event.properties.part, sessionId);
  }
  if (event.type === "session.error" && belongsToSession(event, sessionId)) {
    return {
      chunk: `opencode session error: ${describeMessageError(event.properties.error)}\n`,
      stream: "stderr",
    };
  }
  return;
}

function belongsToSession(
  event: Extract<Event, { type: "session.error" }>,
  sessionId: string
): boolean {
  return (
    event.properties.sessionID === undefined ||
    event.properties.sessionID === sessionId
  );
}

function partChunk(part: Part, sessionId: string): ForwardChunk | undefined {
  if (part.sessionID !== sessionId) {
    return;
  }
  if (part.type === "text") {
    return {
      chunk: `${JSON.stringify({ part: { text: part.text, type: "text" } })}\n`,
      stream: "stdout",
    };
  }
  if (part.type === "tool") {
    return {
      chunk: `opencode tool ${part.tool} ${part.state.status}\n`,
      stream: "stderr",
    };
  }
  return;
}

/**
 * Reconstruct the JSONL stdout the existing normalizeOutput/outputCandidates
 * parser already understands, so the structured-output and repair passes work
 * unchanged on top of SDK responses.
 */
function successResult(
  plan: RunnerLaunchPlan,
  drive: SessionDriveResult
): AgentResult {
  const textParts = drive.parts.filter(
    (part): part is Extract<Part, { type: "text" }> => part.type === "text"
  );
  const stdout = textParts
    .map((part) => JSON.stringify({ part: { text: part.text, type: "text" } }))
    .join("\n");
  const assistantError = drive.assistant?.error;
  if (assistantError) {
    return {
      argv: plan.args,
      exitCode: infraErrorExitCode(assistantError),
      sessionId: drive.sessionId,
      stderr: describeMessageError(assistantError),
      stdout,
    };
  }
  return {
    argv: plan.args,
    exitCode: EXIT_OK,
    sessionId: drive.sessionId,
    stdout,
  };
}

function failureResult(plan: RunnerLaunchPlan, error: unknown): AgentResult {
  return {
    argv: plan.args,
    exitCode: EXIT_INFRA,
    stderr: `opencode session failed: ${errorMessage(error)}`,
    stdout: "",
  };
}

/**
 * Map opencode message errors to the runner's infra-vs-agent exit convention.
 * Output-length / aborted are agent-task outcomes (exit 1, gate territory);
 * provider-auth, API, and unknown are infra (exit 70, retry-eligible).
 */
function infraErrorExitCode(
  error: NonNullable<AssistantMessage["error"]>
): number {
  switch (error.name) {
    case "MessageOutputLengthError":
    case "MessageAbortedError":
      return EXIT_AGENT_ERROR;
    default:
      return EXIT_INFRA;
  }
}

function describeMessageError(
  error: AssistantMessage["error"] | undefined
): string {
  if (!error) {
    return "unknown opencode error";
  }
  const data = error.data as { message?: unknown } | undefined;
  const detail =
    data && typeof data.message === "string" ? `: ${data.message}` : "";
  return `${error.name}${detail}`;
}

interface ResultTuple<T> {
  data?: T;
  error?: unknown;
  request?: Request;
  response?: Response;
}

function unwrap<T>(result: ResultTuple<T>): T {
  if (result.error) {
    throw new Error(resultErrorMessage(result));
  }
  if (result.data === undefined) {
    throw new Error(
      `opencode response contained no data${httpContext(result)}`
    );
  }
  return result.data;
}

/**
 * Build the richest available message for a failed opencode result tuple. The
 * runner reads the result-tuple path (not throwOnError), so the SDK leaves
 * `error` as the raw parsed body — which for a 5xx/timeout is an empty `{}` that
 * stringifies to nothing useful. Walk an ordered precedence (body message →
 * raw string → non-empty JSON body → HTTP status line) so a gateway timeout
 * surfaces as "POST …/prompt → 504 Gateway Timeout" instead of "{}". Mirrors the
 * SDK's own error-interceptor describe().
 */
function resultErrorMessage<T>(result: ResultTuple<T>): string {
  const detail = errorDetail(result.error);
  if (detail) {
    return `${detail}${httpContext(result)}`;
  }
  return httpStatusLine(result) ?? "opencode error with empty response body";
}

// Ordered precedence for the human-readable detail of a failed result body.
function errorDetail(error: unknown): string | undefined {
  return bodyMessage(error) ?? nonEmptyString(error) ?? nonEmptyJson(error);
}

function bodyMessage(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return;
  }
  return (
    stringField(error.data, "message") ??
    stringField(error, "message") ??
    stringField(error, "name")
  );
}

function nonEmptyString(error: unknown): string | undefined {
  return typeof error === "string" && error.length > 0 ? error : undefined;
}

function nonEmptyJson(error: unknown): string | undefined {
  if (error === undefined) {
    return;
  }
  const json = JSON.stringify(error);
  return json && json !== "{}" ? json : undefined;
}

function httpContext<T>(result: ResultTuple<T>): string {
  const status = httpStatusLine(result);
  return status ? ` (${status})` : "";
}

/*
 * Status CODE + target only — deliberately NOT statusText. statusText like
 * "Gateway Timeout" would feed the transient-retry classifier's message regex
 * (`timed?out`) and silently reclassify a post-generation 5xx as a retryable
 * pre-acceptance transport failure, re-running an 11-minute turn. The numeric
 * code is enough to diagnose; classification stays structural.
 */
function httpStatusLine<T>(result: ResultTuple<T>): string | undefined {
  const status = result.response?.status;
  const { request } = result;
  if (!(request?.method || request?.url || status)) {
    return;
  }
  return `${requestTarget(request)}${statusSuffix(status)}`;
}

function requestTarget(request: Request | undefined): string {
  return `${request?.method ?? "?"} ${request?.url ?? "?"}`;
}

function statusSuffix(status: number | undefined): string {
  return status ? ` → HTTP ${status}` : "";
}

function stringField(value: unknown, field: string): string | undefined {
  if (isRecord(value) && typeof value[field] === "string" && value[field]) {
    return value[field];
  }
  return;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
