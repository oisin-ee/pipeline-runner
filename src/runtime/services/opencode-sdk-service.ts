import type { AssistantMessage, Event, OpencodeClient } from "@opencode-ai/sdk/v2";
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
interface EventSubscription {
  stream: AsyncIterator<Event>;
}

export interface OpencodeResultTuple<T> {
  data?: T;
  error?: unknown;
  request?: Request;
  response?: Response;
}

export interface OpencodeCreateSessionData {
  id: string;
}

export interface OpencodeAssistantResult {
  error?: AssistantMessage["error"];
}

export interface OpencodePromptPart {
  sessionID?: string;
  text?: string;
  type: string;
}

export interface OpencodePromptSessionData {
  info?: OpencodeAssistantResult;
  parts: OpencodePromptPart[];
}

export type OpencodeCreateSessionResult = OpencodeResultTuple<OpencodeCreateSessionData>;
export type OpencodePromptSessionResult = OpencodeResultTuple<OpencodePromptSessionData>;

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
    create: (args: CreateSessionArgs) => Promise<OpencodeCreateSessionResult>;
    prompt: (args: PromptSessionArgs) => Promise<OpencodePromptSessionResult>;
    // Optional so minimal test doubles need not stub it; the idle watchdog
    // aborts best-effort and treats a missing method as a no-op.
    abort?: (args: AbortSessionArgs) => Promise<unknown>;
  };
}

export class OpencodeSdkService extends Context.Service<
  OpencodeSdkService,
  {
    readonly createClient: (opts: { baseUrl: string; directory: string }) => Effect.Effect<OpencodeClient, unknown>;
    readonly createSession: (
      client: OpencodeRuntimeClient,
      args: CreateSessionArgs,
    ) => Effect.Effect<OpencodeCreateSessionResult, unknown>;
    readonly promptSession: (
      client: OpencodeRuntimeClient,
      args: PromptSessionArgs,
    ) => Effect.Effect<OpencodePromptSessionResult, unknown>;
    readonly abortSession: (client: OpencodeRuntimeClient, args: AbortSessionArgs) => Effect.Effect<unknown, unknown>;
    readonly spawnServer: (
      args: SpawnArgs,
      spawn?: OpencodeServerSpawn,
    ) => Effect.Effect<{ client: OpencodeClient; server: ServerProcess }, unknown>;
    readonly subscribeEvents: (client: OpencodeRuntimeClient) => Effect.Effect<EventSubscription, unknown>;
  }
>()("OpencodeSdkService") {}

export const OpencodeSdkServiceLive = Layer.succeed(OpencodeSdkService, {
  abortSession: (client, args) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await (client.session.abort?.(args) ?? Promise.resolve()),
    }),
  createClient: (opts) => Effect.try(() => createOpencodeClient(opts)),
  createSession: (client, args) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await client.session.create(args),
    }),
  promptSession: (client, args) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await client.session.prompt(args),
    }),
  spawnServer: (args, spawn = createOpencode as OpencodeServerSpawn) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await spawn(args),
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
