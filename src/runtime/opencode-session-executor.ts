import type { AssistantMessage, Event, Part } from "@opencode-ai/sdk/v2";
import { Duration, Effect, Option } from "effect";

import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import { isNumberValue, isRecord, isStringValue } from "../safe-json";
import { raceDetached } from "./detached-race";
import { EXIT_AGENT_ERROR, EXIT_INFRA, EXIT_OK } from "./exit-codes";
import { opencodeAgentName } from "./opencode-agent-name";
import {
  OpencodeSdkService,
  OpencodeSdkServiceLive,
} from "./services/opencode-sdk-service";
import type {
  OpencodeAssistantResult,
  OpencodePromptPart,
  OpencodeRuntimeClient,
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

export const createOpencodeSessionRegistry = (): OpencodeSessionRegistry => ({
  sessions: new Map(),
});

export interface OpencodeExecutorDeps {
  client: OpencodeRuntimeClient;
  /** Working directory threaded into every create/prompt request. */
  directory: string;
  /** Called with the resolved session id once known (run-state recording). */
  onSession?: (nodeId: string, sessionId: string) => void;
  registry: OpencodeSessionRegistry;
}

interface SessionDriveResult {
  assistant?: OpencodeAssistantResult;
  parts: OpencodePromptPart[];
  sessionId: string;
}

/**
 * Last-progress marker shared between the event pump (which bumps it on every
 * observed SSE event) and the idle watchdog (which fails the session when the
 * gap since the last event exceeds the idle budget). A plain mutable cell, not a
 * Ref: the pump runs in its own detached runtime fiber and we want the hot loop
 * to do a bare assignment, not an Effect.
 */
interface SessionActivity {
  last: number;
}

const timeoutFailure = (
  milliseconds: number,
  message: string
): Effect.Effect<never, Error> =>
  Effect.sleep(Duration.millis(milliseconds)).pipe(
    Effect.andThen(Effect.fail(new Error(message)))
  );

/*
 * Bound each attempt by a wall-clock budget (plan.timeoutMs, from
 * actor.timeout_ms / PIPELINE_AGENT_TIMEOUT_MS). A stalled opencode session
 * never streams a completion; without a budget it runs until the pod's
 * activeDeadlineSeconds kills the whole node. Race the session against an
 * explicit timer failure so timeout is decided by first completion rather than
 * success-only racing.
 * The timeout failure routes through failureResult -> EXIT_INFRA, so the agent
 * node's model fallback advances to the next model.
 */
const boundByAgentTimeout =
  (plan: RunnerLaunchPlan) =>
  <A, R>(
    effect: Effect.Effect<A, unknown, R>
  ): Effect.Effect<A, unknown, R> => {
    const { timeoutMs } = plan;
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return effect;
    }
    return raceDetached(
      effect,
      timeoutFailure(timeoutMs, `agent session timed out after ${timeoutMs}ms`)
    );
  };

const validateOpencodePlan = (
  plan: RunnerLaunchPlan
): Effect.Effect<void, Error> => {
  if (plan.type === "opencode") {
    return Effect.void;
  }
  return Effect.fail(
    new Error(`opencode executor cannot drive runner type '${plan.type}'`)
  );
};

// PIPE-83.4: a worktree-isolated child carries its tree in plan.cwd; fall back
// to the lease directory for normal nodes (where plan.cwd === deps.directory).
const sessionDirectory = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan
): string => plan.cwd;

/*
 * Release the stranded opencode session via the SDK's native session.abort so
 * the server stops the wedged turn rather than leaking it. Best-effort: bounded
 * and error-swallowed so a hung/failed abort can never delay returning the
 * EXIT_INFRA result. No-op when the session id has not been resolved yet.
 */
const abortBestEffort = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan
): Effect.Effect<void, never, OpencodeSdkService> => {
  const sessionId = deps.registry.sessions.get(plan.nodeId);
  if (sessionId === undefined) {
    return Effect.void;
  }
  return Effect.gen(function* effectBody() {
    const sdk = yield* OpencodeSdkService;
    yield* sdk.abortSession(deps.client, {
      directory: sessionDirectory(deps, plan),
      sessionID: sessionId,
    });
  }).pipe(Effect.timeout(Duration.millis(5000)), Effect.asVoid, Effect.ignore);
};

const onIdleTimeout = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions,
  idleMs: number
): Effect.Effect<never, Error, OpencodeSdkService> =>
  Effect.sync(() => {
    options.onOutput?.({
      chunk: `opencode session idle for ${idleMs}ms (no progress); aborting\n`,
      nodeId: plan.nodeId,
      stream: "stderr",
    });
  }).pipe(
    Effect.andThen(abortBestEffort(deps, plan)),
    Effect.andThen(
      Effect.fail(new Error(`agent session idle for ${idleMs}ms (no progress)`))
    )
  );

const idleWatchdog = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions,
  activity: SessionActivity,
  idleMs: number
): Effect.Effect<never, Error, OpencodeSdkService> => {
  const loop: Effect.Effect<never, Error, OpencodeSdkService> = Effect.suspend(
    () => {
      const remaining = idleMs - (Date.now() - activity.last);
      if (remaining <= 0) {
        return onIdleTimeout(deps, plan, options, idleMs);
      }
      return Effect.sleep(Duration.millis(remaining)).pipe(
        Effect.andThen(loop)
      );
    }
  );
  return loop;
};

/*
 * Inactivity guard, complementary to the wall-clock boundByAgentTimeout. An
 * opencode `serve` session can strand mid-turn emitting no SSE `data` events
 * (upstream opencode bug class); the wall-clock only catches that after the full
 * budget. The idle watchdog races the session against a timer that resets on
 * every observed event (see pumpEvents) and fails as soon as the gap exceeds
 * plan.idleTimeoutMs, so a stall surfaces in ~idle budget instead of ~15min.
 * The failure routes through failureResult -> EXIT_INFRA, so the node falls back
 * / argo reschedules. Disabled when no event stream is attached (no progress
 * signal), when the budget is unset/non-positive, or when it is not shorter than
 * the wall-clock (which would already win).
 */
const boundByIdle =
  (
    deps: OpencodeExecutorDeps,
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions,
    activity: SessionActivity
  ) =>
  <A, R>(
    effect: Effect.Effect<A, unknown, R>
  ): Effect.Effect<A, unknown, R | OpencodeSdkService> => {
    const idleMs = plan.idleTimeoutMs;
    if (idleMs === undefined || idleMs <= 0 || options.onOutput === undefined) {
      return effect;
    }
    if (plan.timeoutMs !== undefined && idleMs >= plan.timeoutMs) {
      return effect;
    }
    // raceFirst, not race: the watchdog only ever FAILS (idle), and Effect.race
    // returns the first SUCCESS — it would ignore the watchdog's failure and
    // wait for the (never-succeeding) stalled session. raceFirst settles on the
    // first side to complete by success or failure.
    return raceDetached(
      effect,
      idleWatchdog(deps, plan, options, activity, idleMs)
    );
  };

const stopStream = (stream: EventStreamHandle): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    await stream.stop();
  }).pipe(Effect.ignore);

const recordSession = (
  deps: OpencodeExecutorDeps,
  nodeId: string,
  sessionId: string
): void => {
  deps.onSession?.(nodeId, sessionId);
};

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

const TRANSIENT_TRANSPORT_RE =
  /fetch failed|econnreset|etimedout|enotfound|eai_again|socket hang ?up|network|connection (?:reset|closed|refused)|aborterror|operation was aborted|timed? ?out/iu;

const numericField = (
  container: unknown,
  key: string
): Option.Option<number> => {
  const value = isRecord(container) ? container[key] : undefined;
  return isNumberValue(value) ? Option.some(value) : Option.none();
};

const httpStatusFromError = (error: unknown): Option.Option<number> => {
  const response = isRecord(error) ? error.response : undefined;
  return Option.orElse(numericField(error, "status"), () =>
    Option.orElse(numericField(error, "statusCode"), () =>
      numericField(response, "status")
    )
  );
};

const FLAGS_TAKING_VALUE = new Set([
  "--agent",
  "--dir",
  "--file",
  "--format",
  "--model",
  "--variant",
]);

/**
 * The launch plan carries the prompt inside the CLI argv (`run <prompt>` or
 * `run <prompt> --file <ctx>`). Recover it as the trailing positional arg
 * (skipping flags and their values) so the adapter boundary is identical
 * regardless of transport.
 */
const promptText = (plan: RunnerLaunchPlan): string => {
  const positional = plan.args.filter(
    (arg, index) =>
      index > 0 &&
      !arg.startsWith("-") &&
      !FLAGS_TAKING_VALUE.has(plan.args[index - 1] ?? "")
  );
  return positional.at(-1) ?? "";
};

const parseModel = (
  model?: string
): Option.Option<{ modelID: string; providerID: string }> => {
  if (model === undefined || model.length === 0) {
    return Option.none();
  }
  const slash = model.indexOf("/");
  if (slash === -1) {
    return Option.none();
  }
  return Option.some({
    modelID: model.slice(slash + 1),
    providerID: model.slice(0, slash),
  });
};

// `variant` selects the opencode model variant (reasoning effort) on the prompt
// request. The opencode server (1.17.x) reads it on /session/{id}/message, but
// the SDK's request body type lags and omits it; the JSON body serializer
// forwards the field verbatim, so we declare it here and let it ride through.
const promptBody = (
  plan: RunnerLaunchPlan
): {
  agent?: string;
  model?: { modelID: string; providerID: string };
  parts: { text: string; type: "text" }[];
  variant?: string;
} => {
  const prompt = promptText(plan);
  const model = parseModel(plan.model);
  const agent =
    plan.profileId === undefined || plan.profileId.length === 0
      ? Option.none<string>()
      : Option.some(opencodeAgentName(plan.profileId));
  return {
    parts: [{ text: prompt, type: "text" }],
    ...Option.match(agent, {
      onNone: () => ({}),
      onSome: (value) => ({ agent: value }),
    }),
    ...Option.match(model, {
      onNone: () => ({}),
      onSome: (value) => ({ model: value }),
    }),
    ...(plan.variant === undefined || plan.variant.length === 0
      ? {}
      : { variant: plan.variant }),
  };
};

const promptRequest = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  sessionId: string
) => ({
  directory: sessionDirectory(deps, plan),
  sessionID: sessionId,
  ...promptBody(plan),
});

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

const readNextEvent = (
  iterator: AsyncIterator<Event>
): Effect.Effect<IteratorResult<Event>, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => await iterator.next(),
  });

const requestIteratorReturn = (
  iterator: AsyncIterator<Event>
): Effect.Effect<void> => {
  if (iterator.return === undefined) {
    return Effect.void;
  }
  return Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await iterator.return?.();
    },
  }).pipe(Effect.asVoid, Effect.ignore);
};

const stopIteratorEffect = (
  iterator: AsyncIterator<Event>,
  pump: Promise<void>
): Effect.Effect<void> =>
  Effect.gen(function* effectBody() {
    yield* requestIteratorReturn(iterator);
    yield* Effect.tryPromise(async () => {
      await pump;
    }).pipe(Effect.ignore);
  });

const stopIterator = async (
  iterator: AsyncIterator<Event>,
  pump: Promise<void>
): Promise<void> => {
  await Effect.runPromise(stopIteratorEffect(iterator, pump));
};

interface ForwardChunk {
  chunk: string;
  stream: "stderr" | "stdout";
}

const belongsToSession = (
  event: Extract<Event, { type: "session.error" }>,
  sessionId: string
): boolean =>
  event.properties.sessionID === undefined ||
  event.properties.sessionID === sessionId;

const partChunk = (
  part: Part,
  sessionId: string
): Option.Option<ForwardChunk> => {
  if (part.sessionID !== sessionId) {
    return Option.none();
  }
  if (part.type === "text") {
    return Option.some({
      chunk: `${JSON.stringify({ part: { text: part.text, type: "text" } })}\n`,
      stream: "stdout",
    });
  }
  if (part.type === "tool") {
    return Option.some({
      chunk: `opencode tool ${part.tool} ${part.state.status}\n`,
      stream: "stderr",
    });
  }
  return Option.none();
};

/**
 * Map opencode message errors to the runner's infra-vs-agent exit convention.
 * Output-length / aborted are agent-task outcomes (exit 1, gate territory);
 * provider-auth, API, and unknown are infra (exit 70, retry-eligible).
 */
const infraErrorExitCode = (
  error: NonNullable<AssistantMessage["error"]>
): number => {
  switch (error.name) {
    case "MessageOutputLengthError":
    case "MessageAbortedError": {
      return EXIT_AGENT_ERROR;
    }
    case "ContentFilterError":
    case "ContextOverflowError":
    case "StructuredOutputError": {
      return EXIT_AGENT_ERROR;
    }
    case "APIError":
    case "ProviderAuthError":
    case "UnknownError": {
      return EXIT_INFRA;
    }
    default: {
      return EXIT_INFRA;
    }
  }
};

const describeMessageError = (error?: AssistantMessage["error"]): string => {
  if (error === undefined) {
    return "unknown opencode error";
  }
  const data = isRecord(error.data) ? error.data : undefined;
  const detail =
    data !== undefined && isStringValue(data.message)
      ? `: ${data.message}`
      : "";
  return `${error.name}${detail}`;
};

const eventChunk = (
  event: Event,
  sessionId: string
): Option.Option<ForwardChunk> => {
  if (event.type === "message.part.updated") {
    return partChunk(event.properties.part, sessionId);
  }
  if (event.type === "session.error" && belongsToSession(event, sessionId)) {
    return Option.some({
      chunk: `opencode session error: ${describeMessageError(event.properties.error)}\n`,
      stream: "stderr",
    });
  }
  return Option.none();
};

const forwardEvent = (
  event: Event,
  sessionId: string,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): void => {
  const forwarded = eventChunk(event, sessionId);
  if (Option.isSome(forwarded)) {
    options.onOutput?.({
      chunk: forwarded.value.chunk,
      nodeId: plan.nodeId,
      stream: forwarded.value.stream,
    });
  }
};

/**
 * Reconstruct the JSONL stdout the existing normalizeOutput/outputCandidates
 * parser already understands, so the structured-output and repair passes work
 * unchanged on top of SDK responses.
 */
const successResult = (
  plan: RunnerLaunchPlan,
  drive: SessionDriveResult
): AgentResult => {
  const textParts = drive.parts.filter(
    (part): part is OpencodePromptPart & { text: string; type: "text" } =>
      part.type === "text" && isStringValue(part.text)
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
};

interface ResultTuple<T> {
  data?: T;
  error?: unknown;
  request?: Request;
  response?: Response;
}

const nonEmptyString = (error: unknown): Option.Option<string> =>
  isStringValue(error) && error.length > 0 ? Option.some(error) : Option.none();

const nonEmptyJson = (error: unknown): Option.Option<string> => {
  if (error === undefined) {
    return Option.none();
  }
  const json = JSON.stringify(error);
  return json.length > 0 && json !== "{}" ? Option.some(json) : Option.none();
};

const requestTarget = (request?: Request): string =>
  `${request?.method ?? "?"} ${request?.url ?? "?"}`;

const hasRequestTarget = (request?: Request): boolean =>
  (request?.method !== undefined && request.method.length > 0) ||
  (request?.url !== undefined && request.url.length > 0);

const isHttpStatus = (status?: number): status is number =>
  status !== undefined && status !== 0 && !Number.isNaN(status);

const statusSuffix = (status?: number): string =>
  isHttpStatus(status) ? ` → HTTP ${status}` : "";

/*
 * Status CODE + target only — deliberately NOT statusText. statusText like
 * "Gateway Timeout" would feed the transient-retry classifier's message regex
 * (`timed?out`) and silently reclassify a post-generation 5xx as a retryable
 * pre-acceptance transport failure, re-running an 11-minute turn. The numeric
 * code is enough to diagnose; classification stays structural.
 */
const httpStatusLine = <T>(result: ResultTuple<T>): Option.Option<string> => {
  const status = result.response?.status;
  const { request } = result;
  if (!(hasRequestTarget(request) || isHttpStatus(status))) {
    return Option.none();
  }
  return Option.some(`${requestTarget(request)}${statusSuffix(status)}`);
};

const httpContext = <T>(result: ResultTuple<T>): string => {
  const status = httpStatusLine(result);
  return Option.match(status, {
    onNone: () => "",
    onSome: (value) => ` (${value})`,
  });
};

const stringField = (value: unknown, field: string): Option.Option<string> => {
  const fieldValue = isRecord(value) ? value[field] : undefined;
  if (isStringValue(fieldValue)) {
    return fieldValue.length > 0 ? Option.some(fieldValue) : Option.none();
  }
  return Option.none();
};

const bodyMessage = (error: unknown): Option.Option<string> => {
  if (!isRecord(error)) {
    return Option.none();
  }
  return Option.orElse(stringField(error.data, "message"), () =>
    Option.orElse(stringField(error, "message"), () =>
      stringField(error, "name")
    )
  );
};

// Ordered precedence for the human-readable detail of a failed result body.
const errorDetail = (error: unknown): Option.Option<string> =>
  Option.orElse(bodyMessage(error), () =>
    Option.orElse(nonEmptyString(error), () => nonEmptyJson(error))
  );

/**
 * Build the richest available message for a failed opencode result tuple. The
 * runner reads the result-tuple path (not throwOnError), so the SDK leaves
 * `error` as the raw parsed body — which for a 5xx/timeout is an empty `{}` that
 * stringifies to nothing useful. Walk an ordered precedence (body message →
 * raw string → non-empty JSON body → HTTP status line) so a gateway timeout
 * surfaces as "POST …/prompt → 504 Gateway Timeout" instead of "{}". Mirrors the
 * SDK's own error-interceptor describe().
 */
const resultErrorMessage = <T>(result: ResultTuple<T>): string => {
  const detail = errorDetail(result.error);
  if (Option.isSome(detail)) {
    return `${detail.value}${httpContext(result)}`;
  }
  return Option.getOrElse(
    httpStatusLine(result),
    () => "opencode error with empty response body"
  );
};

const unwrap = <T>(result: ResultTuple<T>): T => {
  if (result.error !== undefined) {
    throw new Error(resultErrorMessage(result));
  }
  if (result.data === undefined) {
    throw new Error(
      `opencode response contained no data${httpContext(result)}`
    );
  }
  return result.data;
};

const unwrapEffect = <T>(response: ResultTuple<T>): Effect.Effect<T, unknown> =>
  Effect.try({ catch: (error) => error, try: () => unwrap(response) });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const emitTransientRetry = (
  ctx: TransientRetryContext,
  error: unknown,
  attempt: number,
  delay: Duration.Duration
): Effect.Effect<void> =>
  Effect.sync(() => {
    ctx.options.onOutput?.({
      chunk: `opencode ${ctx.label} transient failure: ${errorMessage(error)}; retry ${attempt}/${MAX_TRANSIENT_RETRIES} in ${Duration.toMillis(delay)}ms\n`,
      nodeId: ctx.plan.nodeId,
      stream: "stderr",
    });
  });

/**
 * Retry only failures that prove the turn was NOT accepted: transport errors
 * (no completed round trip) and HTTP 429/5xx rejections. Deterministic agent
 * outcomes (output-length, aborted message, schema/contract problems) and gate
 * failures are out of scope and never reach this classifier as retryable.
 */
const isTransientTransportError = (error: unknown): boolean => {
  if (TRANSIENT_TRANSPORT_RE.test(errorMessage(error))) {
    return true;
  }
  const status = httpStatusFromError(error);
  return Option.match(status, {
    onNone: () => false,
    onSome: (value) => value === 429 || value >= 500,
  });
};

const retryTransientTransport = function retryTransientTransport<A>(
  make: () => Effect.Effect<A, unknown, OpencodeSdkService>,
  ctx: TransientRetryContext,
  attempt = 0
): Effect.Effect<A, unknown, OpencodeSdkService> {
  return make().pipe(
    Effect.matchEffect({
      onFailure: (error) => {
        if (
          !(attempt < MAX_TRANSIENT_RETRIES && isTransientTransportError(error))
        ) {
          return Effect.fail(error);
        }
        const nextAttempt = attempt + 1;
        const delay = Duration.millis(TRANSIENT_RETRY_BASE_MS * 2 ** attempt);
        return emitTransientRetry(ctx, error, nextAttempt, delay).pipe(
          Effect.andThen(Effect.sleep(delay)),
          Effect.andThen(retryTransientTransport(make, ctx, nextAttempt))
        );
      },
      onSuccess: (value) => Effect.succeed(value),
    })
  );
};

const promptSessionResult = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  sessionId: string,
  options: RunnerExecutionOptions
): Effect.Effect<SessionDriveResult, unknown, OpencodeSdkService> =>
  // promptSession retry is bounded to transport-class failures (fetch failed,
  // connection reset/timeout, HTTP 429/5xx) raised BEFORE the server accepts the
  // turn — the prompt was provably not accepted, so re-issuing it to the same
  // session does not duplicate an accepted message. A turn that completes and
  // then reports MessageOutputLength/Aborted never throws here (it returns on
  // data.info.error and is classified by successResult), so it is not retried.
  retryTransientTransport(
    () =>
      Effect.gen(function* effectBody() {
        const sdk = yield* OpencodeSdkService;
        const response = yield* sdk.promptSession(
          deps.client,
          promptRequest(deps, plan, sessionId)
        );
        const data = yield* unwrapEffect(response);
        return {
          assistant: data.info,
          parts: data.parts,
          sessionId,
        };
      }),
    { label: "session.prompt", options, plan }
  );

const resolveSessionId = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<string, unknown, OpencodeSdkService> => {
  const existing = deps.registry.sessions.get(plan.nodeId);
  if (existing !== undefined && existing.length > 0) {
    return Effect.succeed(existing);
  }
  return Effect.gen(function* effectBody() {
    // createSession retry is idempotency-safe: no session id is recorded until a
    // create succeeds, so a transient transport failure can be re-issued without
    // orphaning or duplicating a session.
    const session = yield* retryTransientTransport(
      () =>
        Effect.gen(function* createSessionAttempt() {
          const sdk = yield* OpencodeSdkService;
          const created = yield* sdk.createSession(deps.client, {
            directory: plan.cwd,
            title: `moka:${plan.nodeId}`,
          });
          return yield* unwrapEffect(created);
        }),
      { label: "session.create", options, plan }
    );
    deps.registry.sessions.set(plan.nodeId, session.id);
    return session.id;
  });
};

const reportStreamDrop = (
  error: unknown,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<void> =>
  Effect.sync(() => {
    options.onOutput?.({
      chunk: `opencode event stream dropped: ${errorMessage(error)}\n`,
      nodeId: plan.nodeId,
      stream: "stderr",
    });
  });

const pumpEvents = (
  iterator: AsyncIterator<Event>,
  sessionId: string,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions,
  activity: SessionActivity
): Effect.Effect<void> =>
  Effect.gen(function* effectBody() {
    let done = false;
    while (!done) {
      const next = yield* readNextEvent(iterator);
      done = next.done === true;
      if (!done) {
        // Every observed event is progress — including reasoning/tool-progress
        // deltas that forwardEvent ignores — so the idle watchdog only fires on
        // genuine silence.
        activity.last = Date.now();
        forwardEvent(next.value, sessionId, plan, options);
      }
    }
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => reportStreamDrop(error, plan, options),
      onSuccess: () => Effect.void,
    })
  );

const streamEventsToOutput = (
  deps: OpencodeExecutorDeps,
  sessionId: string,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions,
  activity: SessionActivity
): Effect.Effect<EventStreamHandle, unknown, OpencodeSdkService> => {
  if (options.onOutput === undefined) {
    return Effect.succeed({
      stop: async () => {
        /* empty */
      },
    });
  }
  return Effect.gen(function* effectBody() {
    const sdk = yield* OpencodeSdkService;
    const subscription = yield* sdk.subscribeEvents(deps.client);
    const iterator = subscription.stream;
    // Restart the idle clock at stream attach so createSession latency before
    // the first event does not count against the idle budget.
    activity.last = Date.now();
    const pump = Effect.runPromise(
      pumpEvents(iterator, sessionId, plan, options, activity)
    );
    return {
      stop: async () => {
        await stopIterator(iterator, pump);
      },
    };
  });
};

const driveSession = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions,
  activity: SessionActivity
): Effect.Effect<SessionDriveResult, unknown, OpencodeSdkService> =>
  Effect.gen(function* effectBody() {
    const sessionId = yield* resolveSessionId(deps, plan, options);
    recordSession(deps, plan.nodeId, sessionId);
    const stream = yield* streamEventsToOutput(
      deps,
      sessionId,
      plan,
      options,
      activity
    );
    return yield* promptSessionResult(deps, plan, sessionId, options).pipe(
      Effect.ensuring(stopStream(stream))
    );
  });

const failureResult = (
  plan: RunnerLaunchPlan,
  error: unknown
): AgentResult => ({
  argv: plan.args,
  exitCode: EXIT_INFRA,
  stderr: `opencode session failed: ${errorMessage(error)}`,
  stdout: "",
});

const executeOpencodeSession = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<AgentResult, never, OpencodeSdkService> => {
  const activity: SessionActivity = { last: Date.now() };
  return Effect.gen(function* effectBody() {
    const drive = yield* driveSession(deps, plan, options, activity);
    return successResult(plan, drive);
  }).pipe(
    boundByIdle(deps, plan, options, activity),
    boundByAgentTimeout(plan),
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(failureResult(plan, error)),
      onSuccess: (result) => Effect.succeed(result),
    })
  );
};

const executeOpencodeEffect = (
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Effect.Effect<AgentResult, Error, OpencodeSdkService> =>
  Effect.gen(function* effectBody() {
    yield* validateOpencodePlan(plan);
    return yield* executeOpencodeSession(deps, plan, options);
  });

/**
 * SDK-backed replacement for the subprocess `runLaunchPlan`. Conforms to the
 * RuntimeContext.executor seam so agent-node never learns the transport.
 */
export const createOpencodeExecutor = (deps: OpencodeExecutorDeps) =>
  async function execute(
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
