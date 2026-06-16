import type { Event, OpencodeClient } from "@opencode-ai/sdk";
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
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
type CreateSessionResponse = Awaited<
  ReturnType<OpencodeClient["session"]["create"]>
>;
type PromptSessionResponse = Awaited<
  ReturnType<OpencodeClient["session"]["prompt"]>
>;
interface EventSubscription {
  stream: AsyncIterator<Event>;
}

export class OpencodeSdkService extends Context.Tag("OpencodeSdkService")<
  OpencodeSdkService,
  {
    readonly createClient: (opts: {
      baseUrl: string;
      directory: string;
    }) => Effect.Effect<OpencodeClient, unknown>;
    readonly createSession: (
      client: OpencodeClient,
      args: CreateSessionArgs
    ) => Effect.Effect<CreateSessionResponse, unknown>;
    readonly promptSession: (
      client: OpencodeClient,
      args: PromptSessionArgs
    ) => Effect.Effect<PromptSessionResponse, unknown>;
    readonly spawnServer: (
      args: SpawnArgs,
      spawn?: OpencodeServerSpawn
    ) => Effect.Effect<
      { client: OpencodeClient; server: ServerProcess },
      unknown
    >;
    readonly subscribeEvents: (
      client: OpencodeClient
    ) => Effect.Effect<EventSubscription, unknown>;
  }
>() {}

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
  subscribeEvents: (client) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const subscription = await client.event.subscribe();
        return { stream: subscription.stream };
      },
    }),
});
