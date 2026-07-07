import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Event, Provider } from "@opencode-ai/sdk/v2";
import * as Arr from "effect/Array";
import { String, TaggedErrorClass } from "effect/Schema";
import { describe, expect, it } from "vitest";

import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import type { RunnerLaunchPlan } from "../runner";
import { NodeStateStore } from "./node-state-store";
import { leaseOpencodeRuntime } from "./opencode-runtime";
import type {
  OpencodeServerClient,
  OpencodeServerHandle,
} from "./opencode-server";

/*
 * Regression guard for the eager-startup bug: leaseOpencodeRuntime must NOT
 * open an opencode server at lease time, only when an agent node actually
 * invokes the executor. Command/builtin-only runs (and CI without the opencode
 * binary) must never spawn it. See the PIPE-73 release regression.
 */

class MissingOpencodeStubError extends TaggedErrorClass<MissingOpencodeStubError>()(
  "MissingOpencodeStubError",
  {
    message: String,
  }
) {
  constructor(message: string) {
    super({ message });
  }
}

const CONFIG: PipelineConfig = loadPipelineConfig("/repo", {
  allowMissingLintFileReferences: true,
});

const emptyStream =
  async function* emptyStream(): AsyncIterableIterator<Event> {
    await Promise.resolve();
    yield* Arr.empty<Event>();
  };

const opencodeResponse = (body: unknown): Response => Response.json(body);

const fakeConfigSurface = (
  providers: Provider[] = []
): OpencodeServerClient["config"] =>
  createOpencodeClient({
    baseUrl: "http://127.0.0.1:0",
    fetch: async () =>
      await Promise.resolve(opencodeResponse({ default: {}, providers })),
  }).config;

const failingConfigSurface = (
  message: string
): OpencodeServerClient["config"] =>
  createOpencodeClient({
    baseUrl: "http://127.0.0.1:0",
    fetch: async () =>
      await Promise.reject(new MissingOpencodeStubError(message)),
    throwOnError: true,
  }).config;

const fakeModel = (
  providerID: string,
  id: string
): Provider["models"][string] => ({
  api: {
    id: "test",
    npm: "@test/provider",
    url: "https://example.test",
  },
  capabilities: {
    attachment: false,
    input: {
      audio: false,
      image: false,
      pdf: false,
      text: true,
      video: false,
    },
    interleaved: false,
    output: {
      audio: false,
      image: false,
      pdf: false,
      text: true,
      video: false,
    },
    reasoning: true,
    temperature: true,
    toolcall: true,
  },
  cost: {
    cache: {
      read: 0,
      write: 0,
    },
    input: 0,
    output: 0,
  },
  headers: {},
  id,
  limit: {
    context: 200_000,
    output: 16_384,
  },
  name: id,
  options: {},
  providerID,
  release_date: "2026-01-01",
  status: "active",
});

const fakeProvider = (id: string, models: Provider["models"]): Provider => ({
  env: [],
  id,
  models,
  name: id,
  options: {},
  source: "api",
});

const failingOpencodeClient: OpencodeServerClient = {
  config: failingConfigSurface("missing provider stub"),
  event: {
    subscribe: async () => await Promise.resolve({ stream: emptyStream() }),
  },
  session: {
    create: async () =>
      await Promise.reject(
        new MissingOpencodeStubError("missing session.create stub")
      ),
    prompt: async () =>
      await Promise.reject(
        new MissingOpencodeStubError("missing session.prompt stub")
      ),
  },
};

const fakeHandle = (
  client: OpencodeServerClient = failingOpencodeClient
): OpencodeServerHandle => {
  let closed = false;
  return {
    client,
    close: async () => {
      closed = true;
      await Promise.resolve();
    },
    get owned() {
      return closed;
    },
    url: "http://127.0.0.1:0",
  };
};

const textPart = (sessionId: string, text: string) => ({
  sessionID: sessionId,
  text,
  type: "text",
});

const fakeOpencodeClient = (
  sessionId = "ses_runtime"
): OpencodeServerClient => ({
  config: failingOpencodeClient.config,
  event: {
    subscribe: async () => await Promise.resolve({ stream: emptyStream() }),
  },
  session: {
    create: async () =>
      await Promise.resolve({ data: { id: sessionId }, error: undefined }),
    prompt: async () =>
      await Promise.resolve({
        data: {
          info: {},
          parts: [
            textPart(
              sessionId,
              "done; ignore cli-looking session ses_from_text"
            ),
          ],
        },
        error: undefined,
      }),
  },
});

const opencodePlan = (): RunnerLaunchPlan => ({
  args: ["run", "--format", "json", "do the task"],
  command: "opencode",
  cwd: "/repo",
  env: {},
  model: "openai/gpt-5.5-low",
  nodeId: "node-a",
  outputFormat: "text",
  profileId: "moka-code-writer",
  runnerId: "opencode",
  type: "opencode",
});

describe("leaseOpencodeRuntime lazy server startup", () => {
  it("does not open a server when the lease is created", async () => {
    let opens = 0;
    const lease = await leaseOpencodeRuntime({
      config: CONFIG,
      openServer: async () => {
        opens += 1;
        return await Promise.resolve(fakeHandle());
      },
      worktreePath: "/repo",
    });

    expect(opens).toBe(0);
    // A run with no agent nodes never calls the executor; release is a no-op.
    await expect(lease.release()).resolves.toBeUndefined();
    expect(opens).toBe(0);
  });

  it("opens the server once on first executor use and reuses it", async () => {
    let opens = 0;
    const lease = await leaseOpencodeRuntime({
      config: CONFIG,
      openServer: async () => {
        opens += 1;
        return await Promise.resolve(fakeHandle());
      },
      worktreePath: "/repo",
    });

    // The fake client cannot answer a real prompt; we only assert that
    // invoking the executor triggers exactly one lazy server open.
    await Promise.resolve(lease.executor(opencodePlan(), {})).catch(() => {
      // expected: the stub client has no session API
    });
    expect(opens).toBe(1);

    await Promise.resolve(lease.executor(opencodePlan(), {})).catch(() => {
      // second call must reuse the same server, not open another
    });
    expect(opens).toBe(1);

    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("forwards the SDK session id through onSession so run state records node metadata", async () => {
    const nodeStateStore = new NodeStateStore();
    nodeStateStore.nodeStates.set("node-a", {
      attempts: 0,
      evidence: [],
      gates: [],
      id: "node-a",
      status: "pending",
    });
    const observedSessions: { nodeId: string; sessionId: string }[] = [];
    const leaseInput = {
      config: CONFIG,
      onSession: (nodeId: string, sessionId: string) => {
        observedSessions.push({ nodeId, sessionId });
        nodeStateStore.recordSessionId(nodeId, sessionId);
      },
      openServer: async () =>
        await Promise.resolve(fakeHandle(fakeOpencodeClient())),
      worktreePath: "/repo",
    } satisfies Parameters<typeof leaseOpencodeRuntime>[0] & {
      onSession: (nodeId: string, sessionId: string) => void;
    };
    const lease = await leaseOpencodeRuntime(leaseInput);

    try {
      const result = await lease.executor(opencodePlan(), {});

      expect(result.exitCode).toBe(0);
      expect(result.sessionId).toBe("ses_runtime");
    } finally {
      await lease.release();
    }
    expect(observedSessions).toEqual([
      { nodeId: "node-a", sessionId: "ses_runtime" },
    ]);
    const nodeState = nodeStateStore.getNodeState("node-a");
    expect("value" in nodeState ? nodeState.value.sessionId : undefined).toBe(
      "ses_runtime"
    );
  });

  it("resolves available models from the server's authenticated providers", async () => {
    const client: OpencodeServerClient = {
      config: fakeConfigSurface([
        fakeProvider("openai", {
          "gpt-5.5-high": fakeModel("openai", "gpt-5.5-high"),
          "gpt-5.5-low": fakeModel("openai", "gpt-5.5-low"),
        }),
        fakeProvider("opencode-go", {
          "qwen3.7-max": fakeModel("opencode-go", "qwen3.7-max"),
        }),
      ]),
      event: failingOpencodeClient.event,
      session: failingOpencodeClient.session,
    };
    const lease = await leaseOpencodeRuntime({
      config: CONFIG,
      openServer: async () => await Promise.resolve(fakeHandle(client)),
      worktreePath: "/repo",
    });

    const models = await lease.availableModels();
    expect(
      "value" in models ? globalThis.Array.from(models.value) : []
    ).toEqual([
      "openai/gpt-5.5-high",
      "openai/gpt-5.5-low",
      "opencode-go/qwen3.7-max",
    ]);
  });

  it("returns undefined available models when provider listing fails (best-effort)", async () => {
    const client: OpencodeServerClient = {
      config: failingConfigSurface("boom"),
      event: failingOpencodeClient.event,
      session: failingOpencodeClient.session,
    };
    const lease = await leaseOpencodeRuntime({
      config: CONFIG,
      openServer: async () => await Promise.resolve(fakeHandle(client)),
      worktreePath: "/repo",
    });

    expect("value" in (await lease.availableModels())).toBe(false);
  });
});
