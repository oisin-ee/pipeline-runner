import type { Event } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import type { RunnerExecutionOptions, RunnerLaunchPlan } from "../runner";
import { createOpencodeExecutor, createOpencodeSessionRegistry } from "./opencode-session-executor";
import type { OpencodePromptSessionData, OpencodeRuntimeClient } from "./services/opencode-sdk-service";

// The v2 session.prompt request is flat (sessionID + the message body fields).
type RecordedPrompt = Parameters<OpencodeRuntimeClient["session"]["prompt"]>[0];
type PromptInfoError = NonNullable<NonNullable<OpencodePromptSessionData["info"]>["error"]>;
type PromptPart = OpencodePromptSessionData["parts"][number];

interface FakeClientOptions {
  createErrors?: unknown[];
  events?: Event[];
  promptErrors?: unknown[];
  promptInfoError?: PromptInfoError;
  promptParts?: PromptPart[];
  recordCreates?: unknown[];
  recordPrompts?: RecordedPrompt[];
  sessionId?: string;
}

const fakeClient = (options: FakeClientOptions = {}): OpencodeRuntimeClient => {
  const sessionId = options.sessionId ?? "ses_test";
  const events = options.events ?? [];
  const createErrors = [...(options.createErrors ?? [])];
  const promptErrors = [...(options.promptErrors ?? [])];
  // Mirror production: the prompt completes only after the agent's events have
  // streamed, so the executor sees every event before it stops the stream.
  let drained: () => void = () => {
    // replaced once the stream starts
  };
  const streamDrained = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const eventStream = async function* eventStream() {
    await Promise.resolve();
    for (const event of events) {
      yield event;
    }
    drained();
  };
  return {
    event: {
      subscribe: async () => ({ stream: eventStream() }),
    },
    session: {
      create: async () => {
        options.recordCreates?.push(true);
        const failure = createErrors.shift();
        if (failure !== undefined) {
          return await Promise.reject(failure);
        }
        return await Promise.resolve({ data: { id: sessionId }, error: undefined });
      },
      prompt: async (args: RecordedPrompt) => {
        options.recordPrompts?.push(args);
        const failure = promptErrors.shift();
        if (failure !== undefined) {
          throw failure;
        }
        if (events.length > 0) {
          await streamDrained;
        }
        return {
          data: {
            info: options.promptInfoError ? { error: options.promptInfoError } : {},
            parts: options.promptParts ?? [{ sessionID: sessionId, text: "final answer", type: "text" }],
          },
          error: undefined,
        };
      },
    },
  };
};

const opencodePlan = (overrides: Partial<RunnerLaunchPlan> = {}): RunnerLaunchPlan => ({
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
  it("recovers the prompt positional even when a context file follows it", async () => {
    const recordPrompts: RecordedPrompt[] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      ...executorDefaults(),
    });

    await execute(
      opencodePlan({
        args: ["run", "--format", "json", "--dir", "/repo", "do the task", "--file", "/repo/ctx.md"],
      }),
      {},
    );

    expect(recordPrompts[0].parts?.[0]).toMatchObject({ text: "do the task" });
  });

  it("omits the model when the selector has no provider/model split", async () => {
    const recordPrompts: RecordedPrompt[] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      ...executorDefaults(),
    });

    await execute(opencodePlan({ model: "baremodel" }), {});

    expect(recordPrompts[0].model).toBeUndefined();
  });
});

type RecordedAbort =
  NonNullable<OpencodeRuntimeClient["session"]["abort"]> extends (args: infer A) => unknown ? A : never;

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
  abort?: OpencodeRuntimeClient["session"]["abort"],
): OpencodeRuntimeClient => ({
  event: { subscribe: async () => ({ stream }) },
  session: {
    create: async () => ({ data: { id: "ses_test" }, error: undefined }),
    prompt: async () => await new Promise(() => {}),
    ...(abort ? { abort } : {}),
  },
});

// One event, then silence forever: exercises the idle watchdog after a single
// bump of progress activity.
const stallingStream = async function* stallingStream(event: Event): AsyncGenerator<Event> {
  await Promise.resolve();
  yield event;
  await new Promise<void>(() => {});
};

describe("opencode session idle watchdog", () => {
  const progressEvent = progressEventOf("ses_test", 0);

  it("fails a stalled session as infra exit 70 once the idle budget elapses, and aborts it", async () => {
    // One event then silence: the pump bumps activity once, then the gap exceeds
    // the idle budget long before the (much larger) wall-clock would fire.
    const abortCalls: RecordedAbort[] = [];
    const client = stalledIdleClient(stallingStream(progressEvent), async (args) => {
      abortCalls.push(args);
      return true;
    });
    const execute = createOpencodeExecutor({ client, ...executorDefaults() });

    const result = await execute(opencodePlan({ idleTimeoutMs: 60, timeoutMs: 5000 }), { onOutput: () => {} });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("idle");
    expect(abortCalls).toEqual([{ directory: "/repo", sessionID: "ses_test" }]);
  });

  it("resets the idle budget on each event so a steadily-streaming session survives", async () => {
    let drained: () => void = () => {
      // replaced when the stream starts
    };
    const streamDone = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const pacedStream = async function* pacedStream(): AsyncGenerator<Event> {
      for (let index = 0; index < 5; index += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        yield progressEventOf("ses_test", index);
      }
      drained();
    };
    const client: OpencodeRuntimeClient = {
      event: {
        subscribe: async () => ({ stream: pacedStream() }),
      },
      session: {
        create: async () => ({ data: { id: "ses_test" }, error: undefined }),
        prompt: async () => {
          await streamDone;
          return {
            data: {
              info: {},
              parts: [{ sessionID: "ses_test", text: "done", type: "text" }],
            },
            error: undefined,
          };
        },
      },
    };
    const execute = createOpencodeExecutor({ client, ...executorDefaults() });

    // 5 events at 20ms gaps (each well under the 50ms budget) span 100ms total;
    // without per-event resets the 50ms budget would fire mid-stream.
    const result = await execute(opencodePlan({ idleTimeoutMs: 50, timeoutMs: 5000 }), { onOutput: () => {} });

    expect(result.exitCode).toBe(0);
  });

  it("is disabled when no event stream is attached (onOutput unset), leaving only the wall-clock", async () => {
    const client = stalledIdleClient(stallingStream(progressEvent));
    const execute = createOpencodeExecutor({ client, ...executorDefaults() });

    const result = await execute(opencodePlan({ idleTimeoutMs: 40, timeoutMs: 120 }), {});

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("timed out");
  });

  it("is disabled when the idle budget is not shorter than the wall-clock", async () => {
    const client = stalledIdleClient(stallingStream(progressEvent));
    const execute = createOpencodeExecutor({ client, ...executorDefaults() });

    const result = await execute(opencodePlan({ idleTimeoutMs: 5000, timeoutMs: 80 }), { onOutput: () => {} });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("timed out");
  });

  it("still returns infra exit 70 when the abort call rejects", async () => {
    const client = stalledIdleClient(stallingStream(progressEvent), () => {
      throw new Error("abort boom");
    });
    const execute = createOpencodeExecutor({ client, ...executorDefaults() });

    const result = await execute(opencodePlan({ idleTimeoutMs: 60, timeoutMs: 5000 }), { onOutput: () => {} });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("idle");
  });
});

const emptyStream = async function* emptyStream(): AsyncGenerator<Event> {
  await Promise.resolve();
  const none: Event[] = [];
  for (const event of none) {
    yield event;
  }
};

// Never yields and never returns: next() and return() both stay pending, so the
// executor's stop-stream finalizer hangs.
const hangingStream = async function* hangingStream(): AsyncGenerator<Event> {
  await new Promise<void>(() => {});
  yield progressEventOf("ses_test", 1);
};

const stalledSessionClient = (stream: AsyncIterableIterator<Event>): OpencodeRuntimeClient => ({
  event: { subscribe: async () => ({ stream }) },
  session: {
    create: async () => ({ data: { id: "ses_test" }, error: undefined }),
    prompt: async () => await new Promise(() => {}),
  },
});

const returnObservableHangingStream = (onReturn: () => void): AsyncIterableIterator<Event> => {
  let releaseNext: ((value: IteratorResult<Event>) => void) | undefined;
  return {
    next: async () =>
      await new Promise<IteratorResult<Event>>((resolve) => {
        releaseNext = resolve;
      }),
    return: async () => {
      onReturn();
      releaseNext?.({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
};

describe("opencode session executor", () => {
  it("returns the final assistant text as JSONL stdout the parser understands", async () => {
    const execute = createOpencodeExecutor({
      client: fakeClient(),
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_test");
    expect(JSON.parse(result.stdout)).toEqual({
      part: { text: "final answer", type: "text" },
    });
  });

  it("records the session id and reuses it for a second prompt with the same nodeId", async () => {
    const recordPrompts: RecordedPrompt[] = [];
    const registry = createOpencodeSessionRegistry();
    const seen: { nodeId: string; sessionId: string }[] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      directory: "/repo",
      onSession: (nodeId, sessionId) => seen.push({ nodeId, sessionId }),
      registry,
    });

    await execute(opencodePlan(), {});
    await execute(opencodePlan(), {});

    expect(registry.sessions.get("node-a")).toBe("ses_test");
    expect(recordPrompts.map((entry) => entry.sessionID)).toEqual(["ses_test", "ses_test"]);
    expect(seen).toHaveLength(2);
    expect(seen.every((entry) => entry.sessionId === "ses_test")).toBe(true);
  });

  it("uses plan.cwd as the session directory so worktree-isolated children stay isolated (PIPE-83.4)", async () => {
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      directory: "/parent-worktree",
      registry: createOpencodeSessionRegistry(),
    });

    await execute(opencodePlan({ cwd: "/child-worktree" }), {});

    expect(recordPrompts?.[0].directory).toBe("/child-worktree");
  });

  it("selects the opencode agent, split model, and reasoning variant per message", async () => {
    const recordPrompts: RecordedPrompt[] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      ...executorDefaults(),
    });

    await execute(opencodePlan({ variant: "high" }), {});

    const prompt = recordPrompts[0];
    expect(prompt.agent).toBe("MoKa Code Writer");
    expect(prompt.model).toEqual({
      modelID: "gpt-5.5-low",
      providerID: "openai",
    });
    expect(prompt.variant).toBe("high");
  });

  it("forwards streamed text parts to onOutput as JSONL stdout chunks", async () => {
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

    await execute(opencodePlan(), { onOutput });

    const stdout = chunks.filter((entry) => entry.stream === "stdout");
    const stderr = chunks.filter((entry) => entry.stream === "stderr");
    expect(stdout.some((entry) => entry.chunk.includes('"streamed"'))).toBe(true);
    expect(stderr.some((entry) => entry.chunk.includes("tool bash"))).toBe(true);
  });

  it("classifies provider/infra message errors as retry-eligible exit 70", async () => {
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

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("ProviderAuthError");
  });

  it("classifies output-length errors as an agent-task failure exit 1", async () => {
    const execute = createOpencodeExecutor({
      client: fakeClient({
        promptInfoError: { data: {}, name: "MessageOutputLengthError" },
        promptParts: [],
      }),
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(1);
  });

  it("returns infra exit 70 when the session call throws", async () => {
    const throwingClient: OpencodeRuntimeClient = {
      event: {
        subscribe: async () => ({ stream: emptyStream() }),
      },
      session: {
        create: () => {
          throw new Error("boom");
        },
        prompt: () => {
          throw new Error("boom");
        },
      },
    };
    const execute = createOpencodeExecutor({
      client: throwingClient,
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("boom");
  });

  it("times out a stalled session as infra exit 70 so the node can fall back", async () => {
    // A model that streams nothing and never completes the prompt; without a
    // per-attempt budget this would hang until the pod's activeDeadlineSeconds.
    const stalledClient = stalledSessionClient(emptyStream());
    const execute = createOpencodeExecutor({
      client: stalledClient,
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan({ timeoutMs: 80 }), {});

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("timed out");
  });

  it("times out even when the stop-stream finalizer hangs", async () => {
    // The production failure: both the prompt AND the event stream are stuck, so
    // the ensuring(stopStream) finalizer hangs on interruption. The attempt must
    // still return within the budget instead of waiting on that finalizer.
    const hangingClient = stalledSessionClient(hangingStream());
    const execute = createOpencodeExecutor({
      client: hangingClient,
      ...executorDefaults(),
    });

    // onOutput set so the executor subscribes the (hanging) event stream.
    const result = await execute(opencodePlan({ timeoutMs: 80 }), {
      onOutput: () => {},
    });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("timed out");
  });

  it("interrupts timed-out session work in the background", async () => {
    let streamReturn: () => void = () => {
      // replaced below
    };
    const streamReturned = new Promise<"returned">((resolve) => {
      streamReturn = () => {
        resolve("returned");
      };
    });
    const hangingClient = stalledSessionClient(returnObservableHangingStream(streamReturn));
    const execute = createOpencodeExecutor({
      client: hangingClient,
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan({ timeoutMs: 80 }), {
      onOutput: () => {},
    });
    const returned = await Promise.race([
      streamReturned,
      new Promise<"not-returned">((resolve) =>
        setTimeout(() => {
          resolve("not-returned");
        }, 200),
      ),
    ]);

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("timed out");
    expect(returned).toBe("returned");
  });

  it("surfaces the HTTP status when the prompt fails with an empty error body", async () => {
    // The opencode server returns a 504 with an empty body on a long
    // generation; the result-tuple `error` is `{}`, which used to stringify
    // to "opencode session failed: {}" and hide the cause. The status code is
    // surfaced, but statusText ("Gateway Timeout") is NOT — it would trip the
    // transient-retry classifier and re-run the turn — so the prompt is issued
    // exactly once (no reclassification to a retryable transport failure).
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const emptyError504Client: OpencodeRuntimeClient = {
      event: {
        subscribe: async () => ({ stream: emptyStream() }),
      },
      session: {
        create: async () => ({ data: { id: "ses_test" }, error: undefined }),
        prompt: async (args) => {
          recordPrompts.push(args);
          return {
            data: undefined,
            error: {},
            request: new Request("http://opencode/session/ses_test/prompt", {
              method: "POST",
            }),
            response: new Response(null, {
              status: 504,
              statusText: "Gateway Timeout",
            }),
          };
        },
      },
    };
    const execute = createOpencodeExecutor({
      client: emptyError504Client,
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("HTTP 504");
    expect(result.stderr).toContain("POST");
    expect(result.stderr).not.toContain("session failed: {}");
    // Classification unchanged: a post-generation 5xx is not retried.
    expect(recordPrompts).toHaveLength(1);
  });

  it("retries a transient prompt transport failure then succeeds (exit 0)", async () => {
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const chunks: { chunk: string; stream: string }[] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({
        promptErrors: [new Error("fetch failed")],
        recordPrompts,
      }),
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {
      onOutput: (event) => chunks.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(recordPrompts).toHaveLength(2);
    // The transient retry is observable in the run log.
    const stderr = chunks.filter((entry) => entry.stream === "stderr");
    expect(
      stderr.some(
        (entry) => entry.chunk.includes("session.prompt transient failure") && entry.chunk.includes("retry 1/2"),
      ),
    ).toBe(true);
  });

  it("retries an HTTP 5xx prompt rejection then succeeds", async () => {
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({
        promptErrors: [Object.assign(new Error("overloaded"), { status: 529 })],
        recordPrompts,
      }),
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(0);
    expect(recordPrompts).toHaveLength(2);
  });

  it("retries a transient createSession failure before recording the session", async () => {
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

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(0);
    expect(recordCreates).toHaveLength(2);
    expect(registry.sessions.get("node-a")).toBe("ses_test");
  });

  it("stops after the bounded retry budget and returns infra exit 70", async () => {
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

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("fetch failed");
    // One initial attempt + MAX_TRANSIENT_RETRIES (2) = 3, never more.
    expect(recordPrompts).toHaveLength(3);
  });

  it("does not retry a non-transient prompt failure", async () => {
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({
        promptErrors: [new Error("schema contract invalid")],
        recordPrompts,
      }),
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(70);
    expect(recordPrompts).toHaveLength(1);
  });

  it("does not retry a completed turn that reports an output-length error", async () => {
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({
        promptInfoError: { data: {}, name: "MessageOutputLengthError" },
        promptParts: [],
        recordPrompts,
      }),
      ...executorDefaults(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(1);
    expect(recordPrompts).toHaveLength(1);
  });

  it("rejects non-opencode plans", async () => {
    const execute = createOpencodeExecutor({
      client: fakeClient(),
      ...executorDefaults(),
    });

    await expect(execute(opencodePlan({ type: "command" }), {})).rejects.toThrow("cannot drive runner type 'command'");
  });
});
