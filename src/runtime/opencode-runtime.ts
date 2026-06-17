import { Effect } from "effect";
import type { PipelineConfig } from "../config";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import type { OpencodeServerHandle } from "./opencode-server";
import {
  createOpencodeExecutor,
  createOpencodeSessionRegistry,
} from "./opencode-session-executor";
import {
  OpencodeRuntimeServerService,
  OpencodeRuntimeServerServiceLive,
  type OpenOpencodeRuntimeServer,
} from "./services/opencode-runtime-server-service";

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
  /** Called with the SDK session id once the executor resolves it. */
  onSession?: (nodeId: string, sessionId: string) => void;
  signal?: AbortSignal;
  worktreePath: string;
  /** Test seam: override how the server is opened. Defaults to startServer. */
  openServer?: OpenOpencodeRuntimeServer;
}): Promise<OpencodeRuntimeLease> {
  return Effect.runPromise(
    Effect.provide(
      leaseOpencodeRuntimeEffect(input),
      OpencodeRuntimeServerServiceLive
    )
  );
}

function leaseOpencodeRuntimeEffect(input: {
  config: PipelineConfig;
  onSession?: (nodeId: string, sessionId: string) => void;
  signal?: AbortSignal;
  worktreePath: string;
  openServer?: OpenOpencodeRuntimeServer;
}): Effect.Effect<OpencodeRuntimeLease, never, OpencodeRuntimeServerService> {
  const registry = createOpencodeSessionRegistry();
  let handle: OpencodeServerHandle | undefined;
  let pending: Promise<RuntimeExecutor> | undefined;

  const ensureExecutor = (): Promise<RuntimeExecutor> => {
    pending ??= Effect.runPromise(
      Effect.provide(
        ensureExecutorEffect(input, registry),
        OpencodeRuntimeServerServiceLive
      )
    ).then((executor) => {
      handle = executor.handle;
      return executor.delegate;
    });
    return pending;
  };

  return Effect.succeed({
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

function ensureExecutorEffect(
  input: {
    onSession?: (nodeId: string, sessionId: string) => void;
    openServer?: OpenOpencodeRuntimeServer;
    signal?: AbortSignal;
    worktreePath: string;
  },
  registry: ReturnType<typeof createOpencodeSessionRegistry>
): Effect.Effect<
  { delegate: RuntimeExecutor; handle: OpencodeServerHandle },
  unknown,
  OpencodeRuntimeServerService
> {
  return Effect.gen(function* () {
    const server = yield* OpencodeRuntimeServerService;
    const handle = yield* server.open(input);
    const delegate = createOpencodeExecutor({
      client: handle.client,
      directory: input.worktreePath,
      ...(input.onSession ? { onSession: input.onSession } : {}),
      registry,
    });
    return { delegate, handle };
  });
}
