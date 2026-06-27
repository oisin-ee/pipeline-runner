import { Effect } from "effect";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import type { PipelineRuntimeOptions } from "./contracts";
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
  /**
   * Models resolvable in the leased server (every authenticated provider's
   * models, as `provider/model`). Best-effort and cached: returns undefined when
   * availability cannot be determined, so callers apply no filtering rather than
   * starving selection. Resolving it ensures the server, which the run needs
   * anyway.
   */
  availableModels(): Promise<ReadonlySet<string> | undefined>;
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

export function withOpencodeRuntime<T>(
  options: PipelineRuntimeOptions,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>
): Effect.Effect<T, unknown> {
  return Effect.gen(function* () {
    if (options.executor) {
      return yield* run(options);
    }
    const { config, worktreePath } = resolveConfigForRun(options);
    if (configUsesOpencode(config)) {
      return yield* runWithLeasedOpencode(options, config, worktreePath, run);
    }
    return yield* run({ ...options, config });
  });
}

function resolveConfigForRun(options: PipelineRuntimeOptions): {
  config: PipelineConfig;
  worktreePath: string;
} {
  const worktreePath = options.worktreePath ?? process.cwd();
  return {
    config: options.config ?? loadPipelineConfig(worktreePath),
    worktreePath,
  };
}

function runWithLeasedOpencode<T>(
  options: PipelineRuntimeOptions,
  config: PipelineConfig,
  worktreePath: string,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>
): Effect.Effect<T, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* Effect.acquireRelease(
        Effect.tryPromise(() =>
          leaseOpencodeRuntime({
            config,
            ...(options.reporter
              ? { onSession: opencodeSessionReporter(options.reporter) }
              : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            worktreePath,
          })
        ),
        (lease) => Effect.promise(() => lease.release())
      );
      const availableModels = yield* Effect.promise(() =>
        lease.availableModels()
      );
      return yield* run({
        ...options,
        config,
        executor: lease.executor,
        ...(availableModels ? { availableModels } : {}),
      });
    })
  );
}

function opencodeSessionReporter(
  reporter: NonNullable<PipelineRuntimeOptions["reporter"]>
): (nodeId: string, sessionId: string) => void {
  return (nodeId, sessionId) => {
    reporter({ nodeId, sessionId, type: "node.session" });
  };
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
  let availableModelsPending:
    | Promise<ReadonlySet<string> | undefined>
    | undefined;

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

  const resolveAvailableModels = (): Promise<
    ReadonlySet<string> | undefined
  > => {
    availableModelsPending ??= ensureExecutor()
      .then(() =>
        handle ? queryAvailableOpencodeModels(handle.client) : undefined
      )
      .catch(() => undefined);
    return availableModelsPending;
  };

  return Effect.succeed({
    availableModels: resolveAvailableModels,
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

/**
 * Collect every model the leased server can resolve (each authenticated
 * provider's models as `provider/model`) from the opencode `/config/providers`
 * endpoint, for availability-aware model selection.
 */
async function queryAvailableOpencodeModels(
  client: OpencodeServerHandle["client"]
): Promise<ReadonlySet<string>> {
  const response = await client.config.providers();
  const providers = response.data?.providers ?? [];
  return new Set(
    providers.flatMap((provider) =>
      Object.keys(provider.models ?? {}).map(
        (modelId) => `${provider.id}/${modelId}`
      )
    )
  );
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
