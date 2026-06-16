import { Context, Effect, Layer } from "effect";
import {
  type OpencodeServerHandle,
  OpencodeServerStartupError,
  openOpencodeServer,
} from "../opencode-server";

export type OpenOpencodeRuntimeServer = (opts: {
  signal?: AbortSignal;
  worktreePath: string;
}) => Promise<OpencodeServerHandle>;

export class OpencodeRuntimeServerService extends Context.Tag(
  "OpencodeRuntimeServerService"
)<
  OpencodeRuntimeServerService,
  {
    readonly open: (input: {
      openServer?: OpenOpencodeRuntimeServer;
      signal?: AbortSignal;
      worktreePath: string;
    }) => Effect.Effect<OpencodeServerHandle, unknown>;
  }
>() {}

export const OpencodeRuntimeServerServiceLive = Layer.succeed(
  OpencodeRuntimeServerService,
  {
    open: (input) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: () => openRuntimeServer(input),
      }),
  }
);

function openRuntimeServer(input: {
  openServer?: OpenOpencodeRuntimeServer;
  signal?: AbortSignal;
  worktreePath: string;
}): Promise<OpencodeServerHandle> {
  const openServer = input.openServer ?? startServer;
  return openServer(input);
}

async function startServer(input: {
  signal?: AbortSignal;
  worktreePath: string;
}): Promise<OpencodeServerHandle> {
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
}

function startupMessage(error: OpencodeServerStartupError): string {
  return `${error.message}. Confirm the opencode binary is installed and recent enough to expose 'opencode serve', or set OPENCODE_SERVER_URL to an already-running server.`;
}
