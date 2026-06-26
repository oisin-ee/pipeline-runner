import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Context, Effect, Layer } from "effect";

interface ServerProcess {
  close(): void;
  url: string;
}
type SpawnArgs = Parameters<typeof createOpencode>[0];
export type OpencodeServerSpawn = (args: SpawnArgs) => Promise<{
  client: OpencodeClient;
  server: ServerProcess;
}>;
type CreateSessionArgs = Parameters<OpencodeClient["session"]["create"]>[0];
type PromptSessionArgs = Parameters<OpencodeClient["session"]["prompt"]>[0];
type AbortSessionArgs = Parameters<OpencodeClient["session"]["abort"]>[0];
type CreateSessionResponse = Awaited<
  ReturnType<OpencodeClient["session"]["create"]>
>;
type PromptSessionResponse = Awaited<
  ReturnType<OpencodeClient["session"]["prompt"]>
>;
interface EventSubscription {
  stream: AsyncIterator<Event>;
}

/**
 * The runtime only drives session create/prompt and event subscription. Depend
 * on this minimal surface (with loose result shapes) so the full generated v2
 * client AND small test doubles both satisfy it structurally — no casts.
 */
export interface OpencodeRuntimeClient {
  event: {
    subscribe: () => Promise<{ stream: AsyncIterableIterator<Event> }>;
  };
  session: {
    // The service re-types the create/prompt results to the generated response
    // shapes; the client surface only needs to be call-compatible, so the
    // results stay `unknown` and small test doubles satisfy it without casts.
    create: (args: CreateSessionArgs) => Promise<unknown>;
    prompt: (args: PromptSessionArgs) => Promise<unknown>;
    // Optional so minimal test doubles need not stub it; the idle watchdog
    // aborts best-effort and treats a missing method as a no-op.
    abort?: (args: AbortSessionArgs) => Promise<unknown>;
  };
}

export class OpencodeSdkService extends Context.Service<
  OpencodeSdkService,
  {
    readonly createClient: (opts: {
      baseUrl: string;
      directory: string;
    }) => Effect.Effect<OpencodeClient, unknown>;
    readonly createSession: (
      client: OpencodeRuntimeClient,
      args: CreateSessionArgs
    ) => Effect.Effect<CreateSessionResponse, unknown>;
    readonly promptSession: (
      client: OpencodeRuntimeClient,
      args: PromptSessionArgs
    ) => Effect.Effect<PromptSessionResponse, unknown>;
    readonly abortSession: (
      client: OpencodeRuntimeClient,
      args: AbortSessionArgs
    ) => Effect.Effect<unknown, unknown>;
    readonly spawnServer: (
      args: SpawnArgs,
      spawn?: OpencodeServerSpawn
    ) => Effect.Effect<
      { client: OpencodeClient; server: ServerProcess },
      unknown
    >;
    readonly subscribeEvents: (
      client: OpencodeRuntimeClient
    ) => Effect.Effect<EventSubscription, unknown>;
  }
>()("OpencodeSdkService") {}

export const OpencodeSdkServiceLive = Layer.succeed(OpencodeSdkService, {
  createClient: (opts) => Effect.try(() => createOpencodeClient(opts)),
  createSession: (client, args) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => client.session.create(args) as Promise<CreateSessionResponse>,
    }),
  promptSession: (client, args) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => client.session.prompt(args) as Promise<PromptSessionResponse>,
    }),
  spawnServer: (args, spawn = createOpencode as OpencodeServerSpawn) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => spawn(args),
    }),
  abortSession: (client, args) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => client.session.abort?.(args) ?? Promise.resolve(undefined),
    }),
  subscribeEvents: (client) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const subscription = await client.event.subscribe();
        return { stream: subscription.stream };
      },
    }),
});
