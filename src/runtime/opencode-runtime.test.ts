import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../config";
import { leaseOpencodeRuntime } from "./opencode-runtime";
import type { OpencodeServerHandle } from "./opencode-server";

/*
 * Regression guard for the eager-startup bug: leaseOpencodeRuntime must NOT
 * open an opencode server at lease time, only when an agent node actually
 * invokes the executor. Command/builtin-only runs (and CI without the opencode
 * binary) must never spawn it. See the PIPE-73 release regression.
 */

const CONFIG = {} as unknown as PipelineConfig;

function fakeHandle(): OpencodeServerHandle {
  let closed = false;
  return {
    client: {} as OpencodeServerHandle["client"],
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
});
