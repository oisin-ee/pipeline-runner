import type { PipelineConfig } from "../config";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import {
  type OpencodeServerHandle,
  OpencodeServerStartupError,
  openOpencodeServer,
} from "./opencode-server";
import {
  createOpencodeExecutor,
  createOpencodeSessionRegistry,
} from "./opencode-session-executor";

export type RuntimeExecutor = (
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
) => AgentResult | Promise<AgentResult>;

export interface OpencodeRuntimeLease {
  executor: RuntimeExecutor;
  release(): Promise<void>;
}

/**
 * True when the config declares any opencode runner, i.e. the SDK transport is
 * relevant for this run. Command-only configs never start a server.
 */
export function configUsesOpencode(config: PipelineConfig): boolean {
  return Object.values(config.runners).some(
    (runner) => runner.type === "opencode"
  );
}

/**
 * Open one opencode server for the run and return an SDK-backed executor plus a
 * release() that tears the server down. Caller owns the lifecycle:
 *
 *   const lease = await leaseOpencodeRuntime({ config, worktreePath });
 *   try { ...run with lease.executor... } finally { await lease.release(); }
 */
export async function leaseOpencodeRuntime(input: {
  config: PipelineConfig;
  signal?: AbortSignal;
  worktreePath: string;
}): Promise<OpencodeRuntimeLease> {
  let handle: OpencodeServerHandle | undefined = await startServer(input);
  const registry = createOpencodeSessionRegistry();
  const executor = createOpencodeExecutor({
    client: handle.client,
    directory: input.worktreePath,
    registry,
  });
  return {
    executor,
    release: async () => {
      if (handle) {
        await handle.close();
        handle = undefined;
      }
    },
  };
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
      throw new OpencodeServerStartupError(
        `${error.message}. Confirm the opencode binary is installed and recent enough to expose 'opencode serve', or set OPENCODE_SERVER_URL to an already-running server.`,
        { cause: error }
      );
    }
    throw error;
  }
}
