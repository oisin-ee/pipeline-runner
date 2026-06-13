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
 * Return an SDK-backed executor plus a release() that tears the server down.
 * The opencode server is started LAZILY on the first executor call, not at
 * lease time: a run whose ready nodes are all command/builtin (or that fails
 * before any agent node executes) never spawns opencode, so the binary is only
 * required when an agent node actually runs. release() is a no-op if the server
 * was never started. Caller owns the lifecycle:
 *
 *   const lease = await leaseOpencodeRuntime({ config, worktreePath });
 *   try { ...run with lease.executor... } finally { await lease.release(); }
 */
export function leaseOpencodeRuntime(input: {
  config: PipelineConfig;
  signal?: AbortSignal;
  worktreePath: string;
  /** Test seam: override how the server is opened. Defaults to startServer. */
  openServer?: (opts: {
    signal?: AbortSignal;
    worktreePath: string;
  }) => Promise<OpencodeServerHandle>;
}): Promise<OpencodeRuntimeLease> {
  const registry = createOpencodeSessionRegistry();
  const openHandle = input.openServer ?? startServer;
  let handle: OpencodeServerHandle | undefined;
  let pending: Promise<RuntimeExecutor> | undefined;

  const ensureExecutor = (): Promise<RuntimeExecutor> => {
    pending ??= openHandle(input).then((started) => {
      handle = started;
      return createOpencodeExecutor({
        client: started.client,
        directory: input.worktreePath,
        registry,
      });
    });
    return pending;
  };

  return Promise.resolve({
    executor: async (plan, options) => {
      const delegate = await ensureExecutor();
      return await delegate(plan, options);
    },
    release: async () => {
      if (handle) {
        await handle.close();
        handle = undefined;
      }
    },
  });
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
