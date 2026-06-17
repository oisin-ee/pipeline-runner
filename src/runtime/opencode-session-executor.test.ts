import type { OpencodeClient } from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";
import type { RunnerExecutionOptions, RunnerLaunchPlan } from "../runner";
import {
  createOpencodeExecutor,
  createOpencodeSessionRegistry,
} from "./opencode-session-executor";

interface FakeClientOptions {
  createErrors?: unknown[];
  events?: Record<string, unknown>[];
  promptErrors?: unknown[];
  promptInfoError?: { data?: unknown; name: string };
  promptParts?: Record<string, unknown>[];
  recordCreates?: unknown[];
  recordPrompts?: {
    body: unknown;
    path: { id: string };
    query?: { directory?: string };
  }[];
  sessionId?: string;
}

function fakeClient(options: FakeClientOptions = {}): OpencodeClient {
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
  async function* eventStream() {
    await Promise.resolve();
    for (const event of events) {
      yield event;
    }
    drained();
  }
  return {
    event: {
      subscribe: () => Promise.resolve({ stream: eventStream() }),
    },
    session: {
      create: () => {
        options.recordCreates?.push(true);
        const failure = createErrors.shift();
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        return Promise.resolve({ data: { id: sessionId }, error: undefined });
      },
      prompt: async (args: { body: unknown; path: { id: string } }) => {
        options.recordPrompts?.push(args);
        const failure = promptErrors.shift();
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        if (events.length > 0) {
          await streamDrained;
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
  } as unknown as OpencodeClient;
}

function opencodePlan(
  overrides: Partial<RunnerLaunchPlan> = {}
): RunnerLaunchPlan {
  return {
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
  };
}

describe("opencode session executor", () => {
  it("returns the final assistant text as JSONL stdout the parser understands", async () => {
    const execute = createOpencodeExecutor({
      client: fakeClient(),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_test");
    expect(JSON.parse(result.stdout)).toEqual({
      part: { text: "final answer", type: "text" },
    });
  });

  it("records the session id and reuses it for a second prompt with the same nodeId", async () => {
    const recordPrompts: Array<{ body: unknown; path: { id: string } }> = [];
    const registry = createOpencodeSessionRegistry();
    const seen: Array<{ nodeId: string; sessionId: string }> = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      directory: "/repo",
      onSession: (nodeId, sessionId) => seen.push({ nodeId, sessionId }),
      registry,
    });

    await execute(opencodePlan(), {});
    await execute(opencodePlan(), {});

    expect(registry.sessions.get("node-a")).toBe("ses_test");
    expect(recordPrompts.map((entry) => entry.path.id)).toEqual([
      "ses_test",
      "ses_test",
    ]);
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

    expect(recordPrompts?.[0].query?.directory).toBe("/child-worktree");
  });

  it("selects the opencode agent name and split model per message", async () => {
    const recordPrompts: Array<{ body: unknown; path: { id: string } }> = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    await execute(opencodePlan(), {});

    const body = recordPrompts[0].body as {
      agent?: string;
      model?: { modelID: string; providerID: string };
      parts: Array<{ text: string }>;
    };
    expect(body.agent).toBe("MoKa Code Writer");
    expect(body.model).toEqual({
      modelID: "gpt-5.5-low",
      providerID: "openai",
    });
    expect(body.parts[0].text).toBe("do the task");
  });

  it("forwards streamed text parts to onOutput as JSONL stdout chunks", async () => {
    const chunks: Array<{ chunk: string; stream: string }> = [];
    const onOutput: RunnerExecutionOptions["onOutput"] = (event) => {
      chunks.push({ chunk: event.chunk, stream: event.stream });
    };
    const execute = createOpencodeExecutor({
      client: fakeClient({
        events: [
          {
            properties: {
              part: { sessionID: "ses_test", text: "streamed", type: "text" },
            },
            type: "message.part.updated",
          },
          {
            properties: {
              part: {
                callID: "c1",
                sessionID: "ses_test",
                state: { status: "running" },
                tool: "bash",
                type: "tool",
              },
            },
            type: "message.part.updated",
          },
        ],
      }),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    await execute(opencodePlan(), { onOutput });

    const stdout = chunks.filter((entry) => entry.stream === "stdout");
    const stderr = chunks.filter((entry) => entry.stream === "stderr");
    expect(stdout.some((entry) => entry.chunk.includes('"streamed"'))).toBe(
      true
    );
    expect(stderr.some((entry) => entry.chunk.includes("tool bash"))).toBe(
      true
    );
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
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
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
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(1);
  });

  it("returns infra exit 70 when the session call throws", async () => {
    const throwingClient = {
      event: { subscribe: () => Promise.resolve({ stream: emptyStream() }) },
      session: {
        create: () => Promise.reject(new Error("boom")),
        prompt: () => Promise.reject(new Error("boom")),
      },
    } as unknown as OpencodeClient;
    const execute = createOpencodeExecutor({
      client: throwingClient,
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("boom");
  });

  it("retries a transient prompt transport failure then succeeds (exit 0)", async () => {
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const chunks: Array<{ chunk: string; stream: string }> = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({
        promptErrors: [new Error("fetch failed")],
        recordPrompts,
      }),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
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
        (entry) =>
          entry.chunk.includes("session.prompt transient failure") &&
          entry.chunk.includes("retry 1/2")
      )
    ).toBe(true);
  });

  it("retries an HTTP 5xx prompt rejection then succeeds", async () => {
    const recordPrompts: FakeClientOptions["recordPrompts"] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({
        promptErrors: [Object.assign(new Error("overloaded"), { status: 529 })],
        recordPrompts,
      }),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
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
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
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
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
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
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    const result = await execute(opencodePlan(), {});

    expect(result.exitCode).toBe(1);
    expect(recordPrompts).toHaveLength(1);
  });

  it("rejects non-opencode plans", async () => {
    const execute = createOpencodeExecutor({
      client: fakeClient(),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    await expect(
      execute(opencodePlan({ type: "command" }), {})
    ).rejects.toThrow("cannot drive runner type 'command'");
  });
});

describe("opencode prompt body shaping", () => {
  it("recovers the prompt positional even when a context file follows it", async () => {
    const recordPrompts: { body: unknown; path: { id: string } }[] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    await execute(
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
      }),
      {}
    );

    const body = recordPrompts[0].body as { parts: { text: string }[] };
    expect(body.parts[0].text).toBe("do the task");
  });

  it("omits the model when the selector has no provider/model split", async () => {
    const recordPrompts: { body: unknown; path: { id: string } }[] = [];
    const execute = createOpencodeExecutor({
      client: fakeClient({ recordPrompts }),
      directory: "/repo",
      registry: createOpencodeSessionRegistry(),
    });

    await execute(opencodePlan({ model: "baremodel" }), {});

    const body = recordPrompts[0].body as {
      model?: { modelID: string; providerID: string };
    };
    expect(body.model).toBeUndefined();
  });
});

async function* emptyStream() {
  await Promise.resolve();
  if (emptyStream.length > 0) {
    yield {} as Record<string, unknown>;
  }
}
