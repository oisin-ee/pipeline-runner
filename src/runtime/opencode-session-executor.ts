import type {
  AssistantMessage,
  Event,
  OpencodeClient,
  Part,
} from "@opencode-ai/sdk";
import { Effect } from "effect";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import { opencodeAgentName } from "./opencode-agent-name";
import {
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
  client: OpencodeClient;
  /** Working directory threaded into every create/prompt request. */
  directory: string;
  /** Called with the resolved session id once known (run-state recording). */
  onSession?: (nodeId: string, sessionId: string) => void;
  registry: OpencodeSessionRegistry;
}

/**
 * Distinguish infra failure (server/session error -> retry-eligible exit 70)
 * from a normal agent completion (the agent may still have produced a wrong
 * answer; gates decide that, exit 0). This mirrors the EXIT_STARTUP convention
 * in runner-command/run.ts and feeds retry.ts via the node's retry policy.
 */
const EXIT_OK = 0;
const EXIT_AGENT_ERROR = 1;
const EXIT_INFRA = 70;

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
    return await Effect.runPromise(
      Effect.provide(
        executeOpencodeEffect(deps, plan, options),
        OpencodeSdkServiceLive
      )
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
    Effect.catchAll((error) => Effect.succeed(failureResult(plan, error)))
  );
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
    const sessionId = yield* resolveSessionId(deps, plan);
    recordSession(deps, plan.nodeId, sessionId);
    const stream = yield* streamEventsToOutput(deps, sessionId, plan, options);
    return yield* promptSessionResult(deps, plan, sessionId).pipe(
      Effect.ensuring(stopStream(stream))
    );
  });
}

function promptSessionResult(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  sessionId: string
): Effect.Effect<SessionDriveResult, unknown, OpencodeSdkService> {
  return Effect.gen(function* () {
    const sdk = yield* OpencodeSdkService;
    const response = yield* sdk.promptSession(
      deps.client,
      promptRequest(deps, plan, sessionId)
    );
    const data = unwrap(response);
    return {
      ...(data.info ? { assistant: data.info } : {}),
      parts: data.parts ?? [],
      sessionId,
    };
  });
}

function promptRequest(
  deps: OpencodeExecutorDeps,
  plan: RunnerLaunchPlan,
  sessionId: string
) {
  return {
    body: promptBody(plan),
    path: { id: sessionId },
    query: { directory: sessionDirectory(deps, plan) },
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
  plan: RunnerLaunchPlan
): Effect.Effect<string, unknown, OpencodeSdkService> {
  const existing = deps.registry.sessions.get(plan.nodeId);
  if (existing) {
    return Effect.succeed(existing);
  }
  return Effect.gen(function* () {
    const sdk = yield* OpencodeSdkService;
    const created = yield* sdk.createSession(deps.client, {
      body: { title: `moka:${plan.nodeId}` },
      query: { directory: plan.cwd ?? deps.directory },
    });
    const session = unwrap(created);
    deps.registry.sessions.set(plan.nodeId, session.id);
    return session.id;
  });
}

function promptBody(plan: RunnerLaunchPlan): {
  agent?: string;
  model?: { modelID: string; providerID: string };
  parts: Array<{ text: string; type: "text" }>;
} {
  const prompt = promptText(plan);
  const model = parseModel(plan.model);
  const agent = plan.profileId ? opencodeAgentName(plan.profileId) : undefined;
  return {
    parts: [{ text: prompt, type: "text" }],
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
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

function unwrap<T>(response: { data?: T; error?: unknown }): T {
  if (response.error) {
    throw new Error(
      typeof response.error === "string"
        ? response.error
        : JSON.stringify(response.error)
    );
  }
  if (response.data === undefined) {
    throw new Error("opencode response contained no data");
  }
  return response.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
