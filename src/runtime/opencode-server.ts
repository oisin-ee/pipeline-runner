import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Data, Effect } from "effect";

import type { OpencodeServerSpawn } from "./services/opencode-sdk-service";
import {
  OpencodeSdkService,
  OpencodeSdkServiceLive,
} from "./services/opencode-sdk-service";

/**
 * Server lifecycle for the opencode SDK transport.
 *
 * Decision: ONE server per run, shared by every agent node, with one opencode
 * session per node. Parallel agent nodes are isolated by session, not by
 * server, which mirrors how opencode itself multiplexes concurrent work and
 * avoids paying a process-startup cost per node. Trade-off: a server crash
 * fails every in-flight node on that run rather than a single node; we accept
 * this because a crashed opencode process is an infra failure that should retry
 * the whole node anyway (see retry classification in opencode-session-executor),
 * and per-node servers would otherwise multiply port/startup failure surface.
 *
 * Local runs spawn the server with createOpencode(). Runner pods may pre-start
 * `opencode serve` and expose it via OPENCODE_SERVER_URL; when that is set we
 * connect with createOpencodeClient() instead of spawning.
 */
export interface OpencodeServerHandle {
  client: OpencodeClient;
  /** Tear down the server (no-op when connected to an external server). */
  close(): Promise<void>;
  /** True when this handle owns the server process. */
  owned: boolean;
  url: string;
}

export interface OpencodeServerOptions {
  /** Working directory threaded into client-level GET requests (event stream). */
  directory: string;
  /** Override the external-server env var lookup (testing). */
  serverUrl?: string;
  signal?: AbortSignal;
  /** Spawn hook seam for tests; defaults to the real SDK. */
  spawn?: OpencodeServerSpawn;
  startupTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

export class OpencodeServerStartupError extends Data.TaggedError(
  "OpencodeServerStartupError"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(message: string, options?: { cause?: unknown }) {
    super({ cause: options?.cause, message });
  }
}

const connectExternalServer = (
  url: string,
  directory: string
): Effect.Effect<OpencodeServerHandle, unknown, OpencodeSdkService> =>
  Effect.gen(function* effectBody() {
    const sdk = yield* OpencodeSdkService;
    const client = yield* sdk.createClient({ baseUrl: url, directory });
    return {
      client,
      close: async () => {
        /* empty */
      },
      owned: false,
      url,
    };
  });

const spawnArgs = (options: OpencodeServerOptions) => ({
  // port 0 lets the OS assign a free port; the SDK parses the real URL from
  // the server's startup line, so concurrent runs never collide on 4096.
  port: 0,
  ...(options.signal ? { signal: options.signal } : {}),
  timeout: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const startupError = (error: unknown): OpencodeServerStartupError =>
  new OpencodeServerStartupError(
    `Failed to start opencode server: ${errorText(error)}`,
    { cause: error }
  );

const withDirectory = (
  fallback: OpencodeClient,
  url: string,
  directory: string
): OpencodeClient => {
  try {
    return createOpencodeClient({ baseUrl: url, directory });
  } catch {
    return fallback;
  }
};

const ownedHandle = (
  client: OpencodeClient,
  server: { close(): void; url: string },
  directory: string
): OpencodeServerHandle => ({
  // Re-create a client carrying the run directory for GET requests (the event
  // stream); POST requests pass directory per-request explicitly.
  client: withDirectory(client, server.url, directory),
  close: async () => {
    server.close();
    await Promise.resolve();
  },
  owned: true,
  url: server.url,
});

const spawnOwnedServer = (
  options: OpencodeServerOptions
): Effect.Effect<
  OpencodeServerHandle,
  OpencodeServerStartupError,
  OpencodeSdkService
> =>
  Effect.gen(function* effectBody() {
    const sdk = yield* OpencodeSdkService;
    const { client, server } = yield* sdk.spawnServer(
      spawnArgs(options),
      options.spawn
    );
    return ownedHandle(client, server, options.directory);
  }).pipe(Effect.catch((error) => Effect.fail(startupError(error))));

const openOpencodeServerEffect = (
  options: OpencodeServerOptions
): Effect.Effect<
  OpencodeServerHandle,
  OpencodeServerStartupError,
  OpencodeSdkService
> => {
  const externalUrl =
    options.serverUrl ?? process.env.OPENCODE_SERVER_URL ?? "";
  if (externalUrl.length > 0) {
    return connectExternalServer(externalUrl, options.directory).pipe(
      Effect.mapError(startupError)
    );
  }
  return spawnOwnedServer(options);
};

export const openOpencodeServer = async (
  options: OpencodeServerOptions
): Promise<OpencodeServerHandle> =>
  await Effect.runPromise(
    Effect.provide(openOpencodeServerEffect(options), OpencodeSdkServiceLive)
  );
