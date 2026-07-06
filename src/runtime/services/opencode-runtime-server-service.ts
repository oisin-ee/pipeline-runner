import { Context, Effect, Layer } from "effect";

import { OpencodeServerStartupError, openOpencodeServer } from "../opencode-server";
import type { OpencodeServerHandle } from "../opencode-server";

export type OpenOpencodeRuntimeServer = (opts: {
  signal?: AbortSignal;
  worktreePath: string;
}) => Promise<OpencodeServerHandle>;

export class OpencodeRuntimeServerService extends Context.Service<
  OpencodeRuntimeServerService,
  {
    readonly open: (input: {
      openServer?: OpenOpencodeRuntimeServer;
      signal?: AbortSignal;
      worktreePath: string;
    }) => Effect.Effect<OpencodeServerHandle, unknown>;
  }
>()("OpencodeRuntimeServerService") {}

const startupMessage = (error: OpencodeServerStartupError): string =>
  `${error.message}. Confirm the opencode binary is installed and recent enough to expose 'opencode serve', or set OPENCODE_SERVER_URL to an already-running server.`;

const startServer = async (input: { signal?: AbortSignal; worktreePath: string }): Promise<OpencodeServerHandle> => {
  try {
    return await openOpencodeServer({
      directory: input.worktreePath,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (error instanceof OpencodeServerStartupError) {
      throw new OpencodeServerStartupError(startupMessage(error), {
        cause: error,
      });
    }
    throw error;
  }
};

const openRuntimeServer = async (input: {
  openServer?: OpenOpencodeRuntimeServer;
  signal?: AbortSignal;
  worktreePath: string;
}): Promise<OpencodeServerHandle> => {
  const openServer = input.openServer ?? startServer;
  return await openServer(input);
};

export const OpencodeRuntimeServerServiceLive = Layer.succeed(OpencodeRuntimeServerService, {
  open: (input) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await openRuntimeServer(input),
    }),
});
