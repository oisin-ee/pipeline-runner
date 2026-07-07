import { describe, expect, it } from "@effect/vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { RunnerExecutionOptions, RunnerLaunchPlan } from "../runner";
import {
  createOpencodeExecutor,
  createOpencodeSessionRegistry,
} from "./opencode-session-executor";
import type {
  OpencodePromptSessionData,
  OpencodeRuntimeClient,
} from "./services/opencode-sdk-service";

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): PromiseWithResolvers<T>;
  }

  interface PromiseWithResolvers<T> {
    promise: Promise<T>;
    reject(reason?: unknown): void;
    resolve(value: T | PromiseLike<T>): void;
  }
}

// The v2 session.prompt request is flat (sessionID + the message body fields).
type RecordedPrompt = Parameters<OpencodeRuntimeClient["session"]["prompt"]>[0];
type OpencodeExecutor = ReturnType<typeof createOpencodeExecutor>;
type OpencodeExecutionResult = Awaited<ReturnType<OpencodeExecutor>>;
type PromptInfoError = NonNullable<
  NonNullable<OpencodePromptSessionData["info"]>["error"]
>;
type PromptPart = OpencodePromptSessionData["parts"][number];

interface FakeClientOptions {
  createErrors?: Error[];
  events?: Event[];
  promptErrors?: Error[];
  promptInfoError?: PromptInfoError;
  promptParts?: PromptPart[];
  recordCreates?: unknown[];
  recordPrompts?: RecordedPrompt[];
  sessionId?: string;
}

class OpencodeExecutorTestError extends Schema.TaggedErrorClass<OpencodeExecutorTestError>()(
  "OpencodeExecutorTestError",
  { cause: Schema.Unknown }
) {}

const sleepPromise = async (milliseconds: number): Promise<void> => {
  const stream = new ReadableStream<never>({
    start: (controller) => {
      globalThis.setTimeout(() => {
        controller.close();
      }, milliseconds);
    },
  });
  await stream.getReader().read();
};

const resolvedPromise = async <A>(value: A): Promise<A> => {
  await sleepPromise(0);
  return value;
};

const rejectedPromise = async (error: Error): Promise<never> => {
  await sleepPromise(0);
  throw error;
};

const neverPromise = async <A>(): Promise<A> => await Promise.race([]);

const executeEffect = (
  execute: OpencodeExecutor,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions = {}
): Effect.Effect<OpencodeExecutionResult, OpencodeExecutorTestError> =>
  Effect.tryPromise({
    catch: (cause) => new OpencodeExecutorTestError({ cause }),
    try: async () => await execute(plan, options),
  });

const expectExecuteRejects = (
  execute: OpencodeExecutor,
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions,
  message: string
): Effect.Effect<void, OpencodeExecutorTestError> =>
  Effect.tryPromise({
    catch: (cause) => new OpencodeExecutorTestError({ cause }),
    try: async () => {
      await expect(execute(plan, options)).rejects.toThrow(message);
    },
  });

const fakeClient = (options: FakeClientOptions = {}): OpencodeRuntimeClient => {
  const sessionId = options.sessionId ?? "ses_test";
  const events = options.events ?? [];
  const createErrors = [...(options.createErrors ?? [])];
  const promptErrors = [...(options.promptErrors ?? [])];
  // Mirror production: the prompt completes only after the agent's events have
  // streamed, so the executor sees every event before it stops the stream.
  const streamDrained = Promise.withResolvers<null>();
  const drainStream = (): void => {
    streamDrained.resolve(null);
  };
  const eventStream = async function* eventStream() {
    for (const event of events) {
      yield event;
    }
    drainStream();
  };
  return {
    event: {
      subscribe: async () => await resolvedPromise({ stream: eventStream() }),
    },
    session: {
      create: async () => {
        options.recordCreates?.push(true);
        const failure = createErrors.shift();
        if (failure !== undefined) {
          return await rejectedPromise(failure);
        }
        return await resolvedPromise({
          data: { id: sessionId },
          error: undefined,
        });
      },
      prompt: async (args: RecordedPrompt) => {
        options.recordPrompts?.push(args);
        const failure = promptErrors.shift();
        if (failure !== undefined) {
          throw failure;
        }
        if (events.length > 0) {
          await streamDrained.promise;
        }
        return {
          data: {
            info: options.promptInfoError
              ? { error: options.promptInfoError }
              : {},
            parts: options.promptParts ?? [
              { sessionID: sessionId, text: "final answer", type: "text" },
            ],
          },
          error: undefined,
        };
      },
    },
  };
};

const opencodePlan = (
  overrides: Partial<RunnerLaunchPlan> = {}
): RunnerLaunchPlan => ({
  args: [
    "run",
    "--format",
    "json",
    "--model",
    "openai/gpt-5.5-low",
    "--dangerously-skip-permissions",
    "--dir",
    "/repo",
    "do the task",
  ],
  command: "opencode",
  cwd: "/repo",
  env: {},
  model: "openai/gpt-5.5-low",
  nodeId: "node-a",
  outputFormat: "text",
  profileId: "moka-code-writer",
  runnerId: "opencode",
  type: "opencode",
  ...overrides,
});

// Shared executor wiring: every test runs against the same "/repo" directory and
// a fresh session registry. Spread into createOpencodeExecutor({ client, ... }).
const executorDefaults = () => ({
  directory: "/repo",
  registry: createOpencodeSessionRegistry(),
});

describe("opencode prompt body shaping", () => {
  it.effect(
    "recovers the prompt positional even when a context file follows it",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: RecordedPrompt[] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({ recordPrompts }),
          ...executorDefaults(),
        });

        yield* executeEffect(
          execute,
          opencodePlan({
            args: [
              "run",
              "--format",
              "json",
              "--dir",
              "/repo",
              "do the task",
              "--file",
              "/repo/ctx.md",
            ],
          })
        );

        expect(recordPrompts[0].parts?.[0]).toMatchObject({
          text: "do the task",
        });
      })
  );

  it.effect(
    "omits the model when the selector has no provider/model split",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: RecordedPrompt[] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({ recordPrompts }),
          ...executorDefaults(),
        });

        yield* executeEffect(execute, opencodePlan({ model: "baremodel" }));

        expect(recordPrompts[0].model).toBeUndefined();
      })
  );
});

type RecordedAbort =
  NonNullable<OpencodeRuntimeClient["session"]["abort"]> extends (
    args: infer A
  ) => unknown
    ? A
    : never;

const progressEventOf = (sessionID: string, index: number): Event => ({
  id: `evt-${index}`,
  properties: {
    part: {
      id: `prt-${index}`,
      messageID: "msg-1",
      sessionID,
      text: "streamed",
      type: "text",
    },
    sessionID,
    time: index,
  },
  type: "message.part.updated",
});

const stalledIdleClient = (
  stream: AsyncGenerator<Event>,
  abort?: OpencodeRuntimeClient["session"]["abort"]
): OpencodeRuntimeClient => ({
  event: { subscribe: async () => await resolvedPromise({ stream }) },
  session: {
    create: async () =>
      await resolvedPromise({ data: { id: "ses_test" }, error: undefined }),
    prompt: async () => await neverPromise(),
    ...(abort ? { abort } : {}),
  },
});

// One event, then silence forever: exercises the idle watchdog after a single
// bump of progress activity.
const stallingStream = async function* stallingStream(
  event: Event
): AsyncGenerator<Event> {
  yield event;
  await neverPromise();
};

describe("opencode session idle watchdog", () => {
  const progressEvent = progressEventOf("ses_test", 0);

  it.effect(
    "fails a stalled session as infra exit 70 once the idle budget elapses, and aborts it",
    () =>
      Effect.gen(function* effectBody() {
        // One event then silence: the pump bumps activity once, then the gap exceeds
        // the idle budget long before the (much larger) wall-clock would fire.
        const abortCalls: RecordedAbort[] = [];
        const client = stalledIdleClient(
          stallingStream(progressEvent),
          async (args) => {
            abortCalls.push(args);
            return await resolvedPromise(true);
          }
        );
        const execute = createOpencodeExecutor({
          client,
          ...executorDefaults(),
        });

        const result = yield* executeEffect(
          execute,
          opencodePlan({ idleTimeoutMs: 60, timeoutMs: 5000 }),
          { onOutput: () => {} }
        );

        expect(result.exitCode).toBe(70);
        expect(result.stderr).toContain("idle");
        expect(abortCalls).toEqual([
          { directory: "/repo", sessionID: "ses_test" },
        ]);
      })
  );

  it.effect(
    "resets the idle budget on each event so a steadily-streaming session survives",
    () =>
      Effect.gen(function* effectBody() {
        const streamDone = Promise.withResolvers<null>();
        const drainStream = (): void => {
          streamDone.resolve(null);
        };
        const pacedStream =
          async function* pacedStream(): AsyncGenerator<Event> {
            for (let index = 0; index < 5; index += 1) {
              await sleepPromise(20);
              yield progressEventOf("ses_test", index);
            }
            drainStream();
          };
        const client: OpencodeRuntimeClient = {
          event: {
            subscribe: async () =>
              await resolvedPromise({ stream: pacedStream() }),
          },
          session: {
            create: async () =>
              await resolvedPromise({
                data: { id: "ses_test" },
                error: undefined,
              }),
            prompt: async () => {
              await streamDone.promise;
              return {
                data: {
                  info: {},
                  parts: [
                    { sessionID: "ses_test", text: "done", type: "text" },
                  ],
                },
                error: undefined,
              };
            },
          },
        };
        const execute = createOpencodeExecutor({
          client,
          ...executorDefaults(),
        });

        // 5 events at 20ms gaps (each well under the 50ms budget) span 100ms total;
        // without per-event resets the 50ms budget would fire mid-stream.
        const result = yield* executeEffect(
          execute,
          opencodePlan({ idleTimeoutMs: 50, timeoutMs: 5000 }),
          { onOutput: () => {} }
        );

        expect(result.exitCode).toBe(0);
      })
  );

  it.effect(
    "is disabled when no event stream is attached (onOutput unset), leaving only the wall-clock",
    () =>
      Effect.gen(function* effectBody() {
        const client = stalledIdleClient(stallingStream(progressEvent));
        const execute = createOpencodeExecutor({
          client,
          ...executorDefaults(),
        });

        const result = yield* executeEffect(
          execute,
          opencodePlan({ idleTimeoutMs: 40, timeoutMs: 120 })
        );

        expect(result.exitCode).toBe(70);
        expect(result.stderr).toContain("timed out");
      })
  );

  it.effect(
    "is disabled when the idle budget is not shorter than the wall-clock",
    () =>
      Effect.gen(function* effectBody() {
        const client = stalledIdleClient(stallingStream(progressEvent));
        const execute = createOpencodeExecutor({
          client,
          ...executorDefaults(),
        });

        const result = yield* executeEffect(
          execute,
          opencodePlan({ idleTimeoutMs: 5000, timeoutMs: 80 }),
          { onOutput: () => {} }
        );

        expect(result.exitCode).toBe(70);
        expect(result.stderr).toContain("timed out");
      })
  );

  it.effect("still returns infra exit 70 when the abort call rejects", () =>
    Effect.gen(function* effectBody() {
      const client = stalledIdleClient(
        stallingStream(progressEvent),
        async () => await rejectedPromise(new Error("abort boom"))
      );
      const execute = createOpencodeExecutor({ client, ...executorDefaults() });

      const result = yield* executeEffect(
        execute,
        opencodePlan({ idleTimeoutMs: 60, timeoutMs: 5000 }),
        { onOutput: () => {} }
      );

      expect(result.exitCode).toBe(70);
      expect(result.stderr).toContain("idle");
    })
  );
});

const emptyStream = async function* emptyStream(): AsyncGenerator<Event> {
  const none: Event[] = [];
  for (const event of none) {
    yield event;
  }
};

// Never yields and never returns: next() and return() both stay pending, so the
// executor's stop-stream finalizer hangs.
const hangingStream = async function* hangingStream(): AsyncGenerator<Event> {
  await neverPromise();
  yield progressEventOf("ses_test", 1);
};

const stalledSessionClient = (
  stream: AsyncIterableIterator<Event>
): OpencodeRuntimeClient => ({
  event: { subscribe: async () => await resolvedPromise({ stream }) },
  session: {
    create: async () =>
      await resolvedPromise({ data: { id: "ses_test" }, error: undefined }),
    prompt: async () => await neverPromise(),
  },
});

const returnObservableHangingStream = (
  onReturn: () => void
): AsyncIterableIterator<Event> => {
  const nextResult = Promise.withResolvers<IteratorResult<Event>>();
  const done = (): IteratorResult<Event> => ({
    done: true,
    value: progressEventOf("ses_test", 1),
  });
  return {
    next: async () => await nextResult.promise,
    return: async () => {
      const returned = done();
      onReturn();
      nextResult.resolve(returned);
      return await resolvedPromise(returned);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

describe("opencode session executor", () => {
  it.effect(
    "returns final assistant text in JSONL stdout the parser understands",
    () =>
      Effect.gen(function* effectBody() {
        const execute = createOpencodeExecutor({
          client: fakeClient(),
          ...executorDefaults(),
        });

        const result = yield* executeEffect(execute, opencodePlan());

        expect(result.exitCode).toBe(0);
        expect(result.sessionId).toBe("ses_test");
        expect(JSON.parse(result.stdout)).toEqual({
          part: { text: "final answer", type: "text" },
        });
      })
  );

  it.effect(
    "records the session id and reuses it for a second prompt with the same nodeId",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: RecordedPrompt[] = [];
        const registry = createOpencodeSessionRegistry();
        const seen: { nodeId: string; sessionId: string }[] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({ recordPrompts }),
          directory: "/repo",
          onSession: (nodeId, sessionId) => {
            seen.push({ nodeId, sessionId });
          },
          registry,
        });

        yield* executeEffect(execute, opencodePlan());
        yield* executeEffect(execute, opencodePlan());

        expect(registry.sessions.get("node-a")).toBe("ses_test");
        expect(recordPrompts.map((entry) => entry.sessionID)).toEqual([
          "ses_test",
          "ses_test",
        ]);
        expect(seen).toHaveLength(2);
        expect(seen.every((entry) => entry.sessionId === "ses_test")).toBe(
          true
        );
      })
  );

  it.effect(
    "uses plan.cwd for session directory so worktree-isolated children stay isolated (PIPE-83.4)",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: FakeClientOptions["recordPrompts"] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({ recordPrompts }),
          directory: "/parent-worktree",
          registry: createOpencodeSessionRegistry(),
        });

        yield* executeEffect(execute, opencodePlan({ cwd: "/child-worktree" }));

        expect(recordPrompts[0].directory).toBe("/child-worktree");
      })
  );

  it.effect(
    "selects the opencode agent, split model, and reasoning variant per message",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: RecordedPrompt[] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({ recordPrompts }),
          ...executorDefaults(),
        });

        yield* executeEffect(execute, opencodePlan({ variant: "high" }));

        const [prompt] = recordPrompts;
        expect(prompt.agent).toBe("MoKa Code Writer");
        expect(prompt.model).toEqual({
          modelID: "gpt-5.5-low",
          providerID: "openai",
        });
        expect(prompt.variant).toBe("high");
      })
  );

  it.effect(
    "forwards streamed text parts to onOutput JSONL stdout chunks",
    () =>
      Effect.gen(function* effectBody() {
        const chunks: { chunk: string; stream: string }[] = [];
        const onOutput: RunnerExecutionOptions["onOutput"] = (event) => {
          chunks.push({ chunk: event.chunk, stream: event.stream });
        };
        const execute = createOpencodeExecutor({
          client: fakeClient({
            events: [
              {
                id: "evt-1",
                properties: {
                  part: {
                    id: "prt-1",
                    messageID: "msg-1",
                    sessionID: "ses_test",
                    text: "streamed",
                    type: "text",
                  },
                  sessionID: "ses_test",
                  time: 1,
                },
                type: "message.part.updated",
              },
              {
                id: "evt-2",
                properties: {
                  part: {
                    callID: "c1",
                    id: "prt-2",
                    messageID: "msg-1",
                    sessionID: "ses_test",
                    state: { input: {}, status: "running", time: { start: 0 } },
                    tool: "bash",
                    type: "tool",
                  },
                  sessionID: "ses_test",
                  time: 2,
                },
                type: "message.part.updated",
              },
            ],
          }),
          ...executorDefaults(),
        });

        yield* executeEffect(execute, opencodePlan(), { onOutput });

        const stdout = chunks.filter((entry) => entry.stream === "stdout");
        const stderr = chunks.filter((entry) => entry.stream === "stderr");
        expect(stdout.some((entry) => entry.chunk.includes('"streamed"'))).toBe(
          true
        );
        expect(stderr.some((entry) => entry.chunk.includes("tool bash"))).toBe(
          true
        );
      })
  );

  it.effect(
    "classifies provider/infra message errors with retry-eligible exit 70",
    () =>
      Effect.gen(function* effectBody() {
        const execute = createOpencodeExecutor({
          client: fakeClient({
            promptInfoError: {
              data: { message: "auth", providerID: "openai" },
              name: "ProviderAuthError",
            },
            promptParts: [],
          }),
          ...executorDefaults(),
        });

        const result = yield* executeEffect(execute, opencodePlan());

        expect(result.exitCode).toBe(70);
        expect(result.stderr).toContain("ProviderAuthError");
      })
  );

  it.effect(
    "classifies output-length errors with agent-task failure exit 1",
    () =>
      Effect.gen(function* effectBody() {
        const execute = createOpencodeExecutor({
          client: fakeClient({
            promptInfoError: { data: {}, name: "MessageOutputLengthError" },
            promptParts: [],
          }),
          ...executorDefaults(),
        });

        const result = yield* executeEffect(execute, opencodePlan());

        expect(result.exitCode).toBe(1);
      })
  );

  it.effect("returns infra exit 70 when the session call throws", () =>
    Effect.gen(function* effectBody() {
      const throwingClient: OpencodeRuntimeClient = {
        event: {
          subscribe: async () =>
            await resolvedPromise({ stream: emptyStream() }),
        },
        session: {
          create: async () => await rejectedPromise(new Error("boom")),
          prompt: async () => await rejectedPromise(new Error("boom")),
        },
      };
      const execute = createOpencodeExecutor({
        client: throwingClient,
        ...executorDefaults(),
      });

      const result = yield* executeEffect(execute, opencodePlan());

      expect(result.exitCode).toBe(70);
      expect(result.stderr).toContain("boom");
    })
  );

  it.effect(
    "times out a stalled session with infra exit 70 so the node can fall back",
    () =>
      Effect.gen(function* effectBody() {
        // A model that streams nothing and never completes the prompt; without a
        // per-attempt budget this would hang until the pod's activeDeadlineSeconds.
        const stalledClient = stalledSessionClient(emptyStream());
        const execute = createOpencodeExecutor({
          client: stalledClient,
          ...executorDefaults(),
        });

        const result = yield* executeEffect(
          execute,
          opencodePlan({ timeoutMs: 80 })
        );

        expect(result.exitCode).toBe(70);
        expect(result.stderr).toContain("timed out");
      })
  );

  it.effect("times out even when the stop-stream finalizer hangs", () =>
    Effect.gen(function* effectBody() {
      // The production failure: both the prompt AND the event stream are stuck, so
      // the ensuring(stopStream) finalizer hangs on interruption. The attempt must
      // still return within the budget instead of waiting on that finalizer.
      const hangingClient = stalledSessionClient(hangingStream());
      const execute = createOpencodeExecutor({
        client: hangingClient,
        ...executorDefaults(),
      });

      // onOutput set so the executor subscribes the (hanging) event stream.
      const result = yield* executeEffect(
        execute,
        opencodePlan({ timeoutMs: 80 }),
        { onOutput: () => {} }
      );

      expect(result.exitCode).toBe(70);
      expect(result.stderr).toContain("timed out");
    })
  );

  it.live("interrupts timed-out session work in the background", () =>
    Effect.gen(function* effectBody() {
      const returnedMarker = "returned";
      const notReturnedMarker = "not-returned";
      const streamReturned = { current: false };
      const streamReturn = (): void => {
        streamReturned.current = true;
      };
      const hangingClient = stalledSessionClient(
        returnObservableHangingStream(streamReturn)
      );
      const execute = createOpencodeExecutor({
        client: hangingClient,
        ...executorDefaults(),
      });

      const result = yield* executeEffect(
        execute,
        opencodePlan({ timeoutMs: 80 }),
        { onOutput: () => {} }
      );
      yield* Effect.sleep(Duration.millis(200));
      const returned = streamReturned.current
        ? returnedMarker
        : notReturnedMarker;

      expect(result.exitCode).toBe(70);
      expect(result.stderr).toContain("timed out");
      expect(returned).toBe("returned");
    })
  );

  it.effect(
    "surfaces the HTTP status when the prompt fails with an empty error body",
    () =>
      Effect.gen(function* effectBody() {
        // The opencode server returns a 504 with an empty body on a long
        // generation; the result-tuple `error` is `{}`, which used to stringify
        // to "opencode session failed: {}" and hide the cause. The status code is
        // surfaced, but statusText ("Gateway Timeout") is NOT — it would trip the
        // transient-retry classifier and re-run the turn — so the prompt is issued
        // exactly once (no reclassification to a retryable transport failure).
        const recordPrompts: FakeClientOptions["recordPrompts"] = [];
        const emptyError504Client: OpencodeRuntimeClient = {
          event: {
            subscribe: async () =>
              await resolvedPromise({ stream: emptyStream() }),
          },
          session: {
            create: async () =>
              await resolvedPromise({
                data: { id: "ses_test" },
                error: undefined,
              }),
            prompt: async (args) => {
              recordPrompts.push(args);
              return await resolvedPromise({
                data: undefined,
                error: {},
                request: new Request(
                  "http://opencode/session/ses_test/prompt",
                  {
                    method: "POST",
                  }
                ),
                response: new Response(null, {
                  status: 504,
                  statusText: "Gateway Timeout",
                }),
              });
            },
          },
        };
        const execute = createOpencodeExecutor({
          client: emptyError504Client,
          ...executorDefaults(),
        });

        const result = yield* executeEffect(execute, opencodePlan());

        expect(result.exitCode).toBe(70);
        expect(result.stderr).toContain("HTTP 504");
        expect(result.stderr).toContain("POST");
        expect(result.stderr).not.toContain("session failed: {}");
        // Classification unchanged: a post-generation 5xx is not retried.
        expect(recordPrompts).toHaveLength(1);
      })
  );

  it.effect(
    "retries a transient prompt transport failure then succeeds (exit 0)",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: FakeClientOptions["recordPrompts"] = [];
        const chunks: { chunk: string; stream: string }[] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({
            promptErrors: [new Error("fetch failed")],
            recordPrompts,
          }),
          ...executorDefaults(),
        });

        const result = yield* executeEffect(execute, opencodePlan(), {
          onOutput: (event) => {
            chunks.push(event);
          },
        });

        expect(result.exitCode).toBe(0);
        expect(recordPrompts).toHaveLength(2);
        // The transient retry is observable in the run log.
        const stderr = chunks.filter((entry) => entry.stream === "stderr");
        expect(
          stderr.some(
            (entry) =>
              entry.chunk.includes("session.prompt transient failure") &&
              entry.chunk.includes("retry 1/2")
          )
        ).toBe(true);
      })
  );

  it.effect("retries an HTTP 5xx prompt rejection then succeeds", () =>
    Effect.gen(function* effectBody() {
      const recordPrompts: FakeClientOptions["recordPrompts"] = [];
      const execute = createOpencodeExecutor({
        client: fakeClient({
          promptErrors: [
            Object.assign(new Error("overloaded"), { status: 529 }),
          ],
          recordPrompts,
        }),
        ...executorDefaults(),
      });

      const result = yield* executeEffect(execute, opencodePlan());

      expect(result.exitCode).toBe(0);
      expect(recordPrompts).toHaveLength(2);
    })
  );

  it.effect(
    "retries a transient createSession failure before recording the session",
    () =>
      Effect.gen(function* effectBody() {
        const recordCreates: unknown[] = [];
        const registry = createOpencodeSessionRegistry();
        const execute = createOpencodeExecutor({
          client: fakeClient({
            createErrors: [new Error("ECONNRESET")],
            recordCreates,
          }),
          directory: "/repo",
          registry,
        });

        const result = yield* executeEffect(execute, opencodePlan());

        expect(result.exitCode).toBe(0);
        expect(recordCreates).toHaveLength(2);
        expect(registry.sessions.get("node-a")).toBe("ses_test");
      })
  );

  it.effect(
    "stops after the bounded retry budget and returns infra exit 70",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: FakeClientOptions["recordPrompts"] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({
            promptErrors: [
              new Error("fetch failed"),
              new Error("fetch failed"),
              new Error("fetch failed"),
              new Error("fetch failed"),
            ],
            recordPrompts,
          }),
          ...executorDefaults(),
        });

        const result = yield* executeEffect(execute, opencodePlan());

        expect(result.exitCode).toBe(70);
        expect(result.stderr).toContain("fetch failed");
        // One initial attempt + MAX_TRANSIENT_RETRIES (2) = 3, never more.
        expect(recordPrompts).toHaveLength(3);
      })
  );

  it.effect("does not retry a non-transient prompt failure", () =>
    Effect.gen(function* effectBody() {
      const recordPrompts: FakeClientOptions["recordPrompts"] = [];
      const execute = createOpencodeExecutor({
        client: fakeClient({
          promptErrors: [new Error("schema contract invalid")],
          recordPrompts,
        }),
        ...executorDefaults(),
      });

      const result = yield* executeEffect(execute, opencodePlan());

      expect(result.exitCode).toBe(70);
      expect(recordPrompts).toHaveLength(1);
    })
  );

  it.effect(
    "does not retry a completed turn that reports an output-length error",
    () =>
      Effect.gen(function* effectBody() {
        const recordPrompts: FakeClientOptions["recordPrompts"] = [];
        const execute = createOpencodeExecutor({
          client: fakeClient({
            promptInfoError: { data: {}, name: "MessageOutputLengthError" },
            promptParts: [],
            recordPrompts,
          }),
          ...executorDefaults(),
        });

        const result = yield* executeEffect(execute, opencodePlan());

        expect(result.exitCode).toBe(1);
        expect(recordPrompts).toHaveLength(1);
      })
  );

  it.effect("rejects non-opencode plans", () =>
    Effect.gen(function* effectBody() {
      const execute = createOpencodeExecutor({
        client: fakeClient(),
        ...executorDefaults(),
      });

      yield* expectExecuteRejects(
        execute,
        opencodePlan({ type: "command" }),
        {},
        "cannot drive runner type 'command'"
      );
    })
  );
});
