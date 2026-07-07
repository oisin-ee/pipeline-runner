import { afterEach, describe, expect, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";

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
  it.effect(
    "connects to an external server without spawning when a url is set",
    () =>
      Effect.gen(function* effectBody() {
        let spawnCalled = false;
        const handle = yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await openOpencodeServer({
              directory: "/repo",
              serverUrl: "http://127.0.0.1:9999",
              spawn: async () => {
                spawnCalled = true;
                return await Promise.reject(new Error("should not spawn"));
              },
            }),
        });

        expect(spawnCalled).toBe(false);
        expect(handle.owned).toBe(false);
        expect(handle.url).toBe("http://127.0.0.1:9999");
        yield* Effect.tryPromise({
          catch: (error) => error,
          try: async () => {
            await expect(handle.close()).resolves.toBeUndefined();
          },
        });
      })
  );

  it.effect("reads OPENCODE_SERVER_URL from the environment", () =>
    Effect.gen(function* effectBody() {
      process.env.OPENCODE_SERVER_URL = "http://127.0.0.1:8123";
      const handle = yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () => await openOpencodeServer({ directory: "/repo" }),
      });

      expect(handle.owned).toBe(false);
      expect(handle.url).toBe("http://127.0.0.1:8123");
    })
  );

  it.effect("spawns an owned server when no url is configured", () =>
    Effect.gen(function* effectBody() {
      let closed = false;
      const handle = yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () =>
          await openOpencodeServer({
            directory: "/repo",
            serverUrl: "",
            spawn: async () =>
              await Promise.resolve({
                client: createOpencodeClient({ baseUrl: "http://127.0.0.1:0" }),
                server: {
                  close: () => {
                    closed = true;
                  },
                  url: "http://127.0.0.1:4096",
                },
              }),
          }),
      });

      expect(handle.owned).toBe(true);
      yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await handle.close();
        },
      });
      expect(closed).toBe(true);
    })
  );

  it.effect("wraps spawn failures in OpencodeServerStartupError", () =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        await expect(
          openOpencodeServer({
            directory: "/repo",
            serverUrl: "",
            spawn: async () => await Promise.reject(new Error("port in use")),
          })
        ).rejects.toThrow("Failed to start opencode server: port in use");
      },
    })
  );
});
