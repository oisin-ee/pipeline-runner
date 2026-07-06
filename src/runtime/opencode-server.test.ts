import { afterEach, describe, expect, it } from "vitest";

import { openOpencodeServer } from "./opencode-server";

const ORIGINAL_URL = process.env.OPENCODE_SERVER_URL;

afterEach(() => {
  if (ORIGINAL_URL === undefined) {
    process.env.OPENCODE_SERVER_URL = undefined;
    Reflect.deleteProperty(process.env, "OPENCODE_SERVER_URL");
  } else {
    process.env.OPENCODE_SERVER_URL = ORIGINAL_URL;
  }
});

describe("opencode server lifecycle", () => {
  it("connects to an external server without spawning when a url is set", async () => {
    let spawnCalled = false;
    const handle = await openOpencodeServer({
      directory: "/repo",
      serverUrl: "http://127.0.0.1:9999",
      spawn: () => {
        spawnCalled = true;
        throw new Error("should not spawn");
      },
    });

    expect(spawnCalled).toBe(false);
    expect(handle.owned).toBe(false);
    expect(handle.url).toBe("http://127.0.0.1:9999");
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it("reads OPENCODE_SERVER_URL from the environment", async () => {
    process.env.OPENCODE_SERVER_URL = "http://127.0.0.1:8123";
    const handle = await openOpencodeServer({ directory: "/repo" });

    expect(handle.owned).toBe(false);
    expect(handle.url).toBe("http://127.0.0.1:8123");
  });

  it("spawns an owned server when no url is configured", async () => {
    let closed = false;
    const handle = await openOpencodeServer({
      directory: "/repo",
      serverUrl: "",
      spawn: async () => ({
        client: {} as never,
        server: {
          close: () => {
            closed = true;
          },
          url: "http://127.0.0.1:4096",
        },
      }),
    });

    expect(handle.owned).toBe(true);
    await handle.close();
    expect(closed).toBe(true);
  });

  it("wraps spawn failures in OpencodeServerStartupError", async () => {
    await expect(
      openOpencodeServer({
        directory: "/repo",
        serverUrl: "",
        spawn: () => {
          throw new Error("port in use");
        },
      }),
    ).rejects.toThrow("Failed to start opencode server: port in use");
  });
});
