import { Effect, Option } from "effect";

import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import type { AgentResult, RunnerExecutionOptions, RunnerLaunchPlan } from "../runner";
import type { PipelineRuntimeOptions } from "./contracts";
import type { OpencodeServerHandle } from "./opencode-server";
import { createOpencodeExecutor, createOpencodeSessionRegistry } from "./opencode-session-executor";
import {
  OpencodeRuntimeServerService,
  OpencodeRuntimeServerServiceLive,
} from "./services/opencode-runtime-server-service";
import type { OpenOpencodeRuntimeServer } from "./services/opencode-runtime-server-service";

export type RuntimeExecutor = (
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions,
) => AgentResult | Promise<AgentResult>;

const NO_AVAILABLE_MODELS = Option.none<ReadonlySet<string>>();

export interface OpencodeRuntimeLease {
  /**
   * Models resolvable in the leased server (every authenticated provider's
   * models, as `provider/model`). Best-effort and cached: returns undefined when
   * availability cannot be determined, so callers apply no filtering rather than
   * starving selection. Resolving it ensures the server, which the run needs
   * anyway.
   */
  availableModels(): Promise<Option.Option<ReadonlySet<string>>>;
  executor: RuntimeExecutor;
  release(): Promise<void>;
}

/**
 * True when the config declares any opencode runner, i.e. the SDK transport is
 * relevant for this run. Command-only configs never start a server.
 */
export const configUsesOpencode = (config: PipelineConfig): boolean =>
  Object.values(config.runners).some((runner) => runner.type === "opencode");

const resolveConfigForRun = (
  options: PipelineRuntimeOptions,
): {
  config: PipelineConfig;
  worktreePath: string;
} => {
  const worktreePath = options.worktreePath ?? process.cwd();
  return {
    config: options.config ?? loadPipelineConfig(worktreePath),
    worktreePath,
  };
};

const opencodeSessionReporter =
  (reporter: NonNullable<PipelineRuntimeOptions["reporter"]>): ((nodeId: string, sessionId: string) => void) =>
  (nodeId, sessionId) => {
    reporter({ nodeId, sessionId, type: "node.session" });
  };

/**
 * Collect every model the leased server can resolve (each authenticated
 * provider's models as `provider/model`) from the opencode `/config/providers`
 * endpoint, for availability-aware model selection.
 */
const queryAvailableOpencodeModels = async (client: OpencodeServerHandle["client"]): Promise<ReadonlySet<string>> => {
  const response = await client.config.providers();
  const providers = response.data?.providers ?? [];
  return new Set(
    providers.flatMap((provider) => Object.keys(provider.models).map((modelId) => `${provider.id}/${modelId}`)),
  );
};

const ensureExecutorEffect = (
  input: {
    onSession?: (nodeId: string, sessionId: string) => void;
    openServer?: OpenOpencodeRuntimeServer;
    signal?: AbortSignal;
    worktreePath: string;
  },
  registry: ReturnType<typeof createOpencodeSessionRegistry>,
): Effect.Effect<{ delegate: RuntimeExecutor; handle: OpencodeServerHandle }, unknown, OpencodeRuntimeServerService> =>
  Effect.gen(function* effectBody() {
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

const leaseOpencodeRuntimeEffect = (input: {
  config: PipelineConfig;
  onSession?: (nodeId: string, sessionId: string) => void;
  signal?: AbortSignal;
  worktreePath: string;
  openServer?: OpenOpencodeRuntimeServer;
}): Effect.Effect<OpencodeRuntimeLease, never, OpencodeRuntimeServerService> => {
  const registry = createOpencodeSessionRegistry();
  let handle = Option.none<OpencodeServerHandle>();
  let pending = Option.none<Promise<RuntimeExecutor>>();
  let availableModelsPending = Option.none<Promise<Option.Option<ReadonlySet<string>>>>();

  const ensureExecutor = async (): Promise<RuntimeExecutor> => {
    const executorPromise = Option.getOrElse(pending, async () => {
      const next = Effect.runPromise(
        Effect.provide(ensureExecutorEffect(input, registry), OpencodeRuntimeServerServiceLive),
      ).then((executor) => {
        handle = Option.some(executor.handle);
        return executor.delegate;
      });
      pending = Option.some(next);
      return await next;
    });
    return await executorPromise;
  };

  const resolveAvailableModels = async (): Promise<Option.Option<ReadonlySet<string>>> => {
    const modelsPromise = Option.getOrElse(availableModelsPending, async () => {
      const next = ensureExecutor()
        .then(async () => {
          if (Option.isNone(handle)) {
            return Option.none<ReadonlySet<string>>();
          }
          return Option.some(await queryAvailableOpencodeModels(handle.value.client));
        })
        .catch(() => NO_AVAILABLE_MODELS);
      availableModelsPending = Option.some(next);
      return await next;
    });
    return await modelsPromise;
  };

  return Effect.succeed({
    availableModels: resolveAvailableModels,
    executor: async (plan, options) => {
      const delegate = await ensureExecutor();
      return await delegate(plan, options);
    },
    release: async () => {
      if (Option.isSome(handle)) {
        await handle.value.close();
        handle = Option.none();
      }
    },
  });
};

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
export const leaseOpencodeRuntime = async (input: {
  config: PipelineConfig;
  /** Called with the SDK session id once the executor resolves it. */
  onSession?: (nodeId: string, sessionId: string) => void;
  signal?: AbortSignal;
  worktreePath: string;
  /** Test seam: override how the server is opened. Defaults to startServer. */
  openServer?: OpenOpencodeRuntimeServer;
}): Promise<OpencodeRuntimeLease> =>
  await Effect.runPromise(Effect.provide(leaseOpencodeRuntimeEffect(input), OpencodeRuntimeServerServiceLive));

const runWithLeasedOpencode = <T>(
  options: PipelineRuntimeOptions,
  config: PipelineConfig,
  worktreePath: string,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>,
): Effect.Effect<T, unknown> =>
  Effect.scoped(
    Effect.gen(function* effectBody() {
      const lease = yield* Effect.acquireRelease(
        Effect.tryPromise(
          async () =>
            await leaseOpencodeRuntime({
              config,
              ...(options.reporter === undefined ? {} : { onSession: opencodeSessionReporter(options.reporter) }),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              worktreePath,
            }),
        ),
        (lease) =>
          Effect.promise(async () => {
            await lease.release();
          }),
      );
      const availableModels = yield* Effect.promise(async () => await lease.availableModels());
      return yield* run({
        ...options,
        config,
        executor: lease.executor,
        ...(Option.isSome(availableModels) ? { availableModels: availableModels.value } : {}),
      });
    }),
  );

export const withOpencodeRuntime = <T>(
  options: PipelineRuntimeOptions,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>,
): Effect.Effect<T, unknown> =>
  Effect.gen(function* effectBody() {
    if (options.executor !== undefined) {
      return yield* run(options);
    }
    const { config, worktreePath } = resolveConfigForRun(options);
    if (configUsesOpencode(config)) {
      return yield* runWithLeasedOpencode(options, config, worktreePath, run);
    }
    return yield* run({ ...options, config });
  });
