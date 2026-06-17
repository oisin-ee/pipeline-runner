import type { OpencodeClient } from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../config";
import type { RunnerLaunchPlan } from "../runner";
import { NodeStateStore } from "./node-state-store";
import { leaseOpencodeRuntime } from "./opencode-runtime";
import type { OpencodeServerHandle } from "./opencode-server";

/*
 * Regression guard for the eager-startup bug: leaseOpencodeRuntime must NOT
 * open an opencode server at lease time, only when an agent node actually
 * invokes the executor. Command/builtin-only runs (and CI without the opencode
 * binary) must never spawn it. See the PIPE-73 release regression.
 */

const CONFIG = {} as unknown as PipelineConfig;

function fakeHandle(
  client: OpencodeServerHandle["client"] = {} as never
): OpencodeServerHandle {
  let closed = false;
  return {
    client,
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    get owned() {
      return closed;
    },
    url: "http://127.0.0.1:0",
  } as OpencodeServerHandle;
}

function fakeOpencodeClient(sessionId = "ses_runtime"): OpencodeClient {
  return {
    session: {
      create: () =>
        Promise.resolve({ data: { id: sessionId }, error: undefined }),
      prompt: () =>
        Promise.resolve({
          data: {
            info: {},
            parts: [
              {
                sessionID: sessionId,
                text: "done; ignore cli-looking session ses_from_text",
                type: "text",
              },
            ],
          },
          error: undefined,
        }),
    },
  } as unknown as OpencodeClient;
}

function opencodePlan(): RunnerLaunchPlan {
  return {
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
  };
}

describe("leaseOpencodeRuntime lazy server startup", () => {
  it("does not open a server when the lease is created", async () => {
    let opens = 0;
    const lease = await leaseOpencodeRuntime({
      config: CONFIG,
      worktreePath: "/repo",
      openServer: () => {
        opens += 1;
        return Promise.resolve(fakeHandle());
      },
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
      worktreePath: "/repo",
      openServer: () => {
        opens += 1;
        return Promise.resolve(fakeHandle());
      },
    });

    // The fake client cannot answer a real prompt; we only assert that
    // invoking the executor triggers exactly one lazy server open.
    await Promise.resolve(
      lease.executor({ command: "opencode", args: [] } as never, {} as never)
    ).catch(() => {
      // expected: the stub client has no session API
    });
    expect(opens).toBe(1);

    await Promise.resolve(
      lease.executor({ command: "opencode", args: [] } as never, {} as never)
    ).catch(() => {
      // second call must reuse the same server, not open another
    });
    expect(opens).toBe(1);

    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("forwards the SDK session id through onSession so run state records node metadata", async () => {
    const nodeStateStore = new NodeStateStore({
      nodeStates: new Map([
        [
          "node-a",
          {
            attempts: 0,
            evidence: [],
            gates: [],
            id: "node-a",
            status: "pending",
          },
        ],
      ]),
    });
    const observedSessions: Array<{ nodeId: string; sessionId: string }> = [];
    const leaseInput = {
      config: CONFIG,
      onSession: (nodeId: string, sessionId: string) => {
        observedSessions.push({ nodeId, sessionId });
        nodeStateStore.recordSessionId(nodeId, sessionId);
      },
      openServer: () => Promise.resolve(fakeHandle(fakeOpencodeClient())),
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
    expect(nodeStateStore.getNodeState("node-a")?.sessionId).toBe(
      "ses_runtime"
    );
  });

  it("resolves available models from the server's authenticated providers", async () => {
    const client = {
      config: {
        providers: () =>
          Promise.resolve({
            data: {
              providers: [
                {
                  id: "openai",
                  models: { "gpt-5.5-high": {}, "gpt-5.5-low": {} },
                },
                { id: "opencode-go", models: { "qwen3.7-max": {} } },
              ],
            },
            error: undefined,
          }),
      },
    } as unknown as OpencodeServerHandle["client"];
    const lease = await leaseOpencodeRuntime({
      config: CONFIG,
      openServer: () => Promise.resolve(fakeHandle(client)),
      worktreePath: "/repo",
    });

    expect(await lease.availableModels()).toEqual(
      new Set([
        "openai/gpt-5.5-high",
        "openai/gpt-5.5-low",
        "opencode-go/qwen3.7-max",
      ])
    );
  });

  it("returns undefined available models when provider listing fails (best-effort)", async () => {
    const client = {
      config: { providers: () => Promise.reject(new Error("boom")) },
    } as unknown as OpencodeServerHandle["client"];
    const lease = await leaseOpencodeRuntime({
      config: CONFIG,
      openServer: () => Promise.resolve(fakeHandle(client)),
      worktreePath: "/repo",
    });

    expect(await lease.availableModels()).toBeUndefined();
  });
});
