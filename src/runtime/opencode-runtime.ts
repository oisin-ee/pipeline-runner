import { Effect, Option } from "effect";

import { loadPipelineConfig } from "../config";
import type { PipelineConfig } from "../config";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import type { PipelineRuntimeOptions } from "./contracts";
import {
  OpencodeServerStartupError,
  openOpencodeServer,
} from "./opencode-server";
import type { OpencodeServerHandle } from "./opencode-server";
import {
  createOpencodeExecutor,
  createOpencodeSessionRegistry,
} from "./opencode-session-executor";
import {
  OpencodeRuntimeServerService,
  OpencodeRuntimeServerServiceLive,
} from "./services/opencode-runtime-server-service";
import type { OpenOpencodeRuntimeServer } from "./services/opencode-runtime-server-service";

export type RuntimeExecutor = (
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
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

interface OpencodeRuntimeLeaseInput {
  config: PipelineConfig;
  onSession?: (nodeId: string, sessionId: string) => void;
  signal?: AbortSignal;
  worktreePath: string;
  openServer?: OpenOpencodeRuntimeServer;
}

interface OpenedOpencodeRuntime {
  availableModels: Option.Option<ReadonlySet<string>>;
  executor: RuntimeExecutor;
  handle: OpencodeServerHandle;
}

/**
 * True when the config declares any opencode runner, i.e. the SDK transport is
 * relevant for this run. Command-only configs never start a server.
 */
export const configUsesOpencode = (config: PipelineConfig): boolean =>
  Object.values(config.runners).some((runner) => runner.type === "opencode");

const startupMessage = (error: OpencodeServerStartupError): string =>
  `${error.message}. Confirm the opencode binary is installed and recent enough to expose 'opencode serve', or set OPENCODE_SERVER_URL to an already-running server.`;

const startServer = async (input: {
  signal?: AbortSignal;
  worktreePath: string;
}): Promise<OpencodeServerHandle> => {
  const [result] = await Promise.allSettled([
    openOpencodeServer({
      directory: input.worktreePath,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  ]);
  if (result.status === "fulfilled") {
    return result.value;
  }
  if (result.reason instanceof OpencodeServerStartupError) {
    throw new OpencodeServerStartupError(startupMessage(result.reason), {
      cause: result.reason,
    });
  }
  throw result.reason;
};

const openRuntimeServer = async (input: {
  openServer?: OpenOpencodeRuntimeServer;
  signal?: AbortSignal;
  worktreePath: string;
}): Promise<OpencodeServerHandle> => {
  const openServer = input.openServer ?? startServer;
  return await openServer(input);
};

const resolveConfigForRun = (
  options: PipelineRuntimeOptions
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
  (
    reporter: NonNullable<PipelineRuntimeOptions["reporter"]>
  ): ((nodeId: string, sessionId: string) => void) =>
  (nodeId, sessionId) => {
    reporter({ nodeId, sessionId, type: "node.session" });
  };

/**
 * Collect every model the leased server can resolve (each authenticated
 * provider's models as `provider/model`) from the opencode `/config/providers`
 * endpoint, for availability-aware model selection.
 */
const queryAvailableOpencodeModels = async (
  client: OpencodeServerHandle["client"]
): Promise<ReadonlySet<string>> => {
  const response = await client.config.providers();
  const providers = response.data?.providers ?? [];
  return new Set(
    providers.flatMap((provider) =>
      Object.keys(provider.models).map((modelId) => `${provider.id}/${modelId}`)
    )
  );
};

const queryAvailableOpencodeModelsEffect = (
  client: OpencodeServerHandle["client"]
): Effect.Effect<Option.Option<ReadonlySet<string>>> =>
  Effect.tryPromise({
    catch: () => NO_AVAILABLE_MODELS,
    try: async () => Option.some(await queryAvailableOpencodeModels(client)),
  }).pipe(
    Effect.match({
      onFailure: (models) => models,
      onSuccess: (models) => models,
    })
  );

const createRuntimeExecutor = (
  handle: OpencodeServerHandle,
  input: OpencodeRuntimeLeaseInput,
  registry: ReturnType<typeof createOpencodeSessionRegistry>
): RuntimeExecutor =>
  createOpencodeExecutor({
    client: handle.client,
    directory: input.worktreePath,
    ...(input.onSession ? { onSession: input.onSession } : {}),
    registry,
  });

const createOpencodeRuntimeLease = (
  input: OpencodeRuntimeLeaseInput
): OpencodeRuntimeLease => {
  const registry = createOpencodeSessionRegistry();
  let handle = Option.none<OpencodeServerHandle>();
  let pending = Option.none<Promise<RuntimeExecutor>>();
  let availableModelsPending =
    Option.none<Promise<Option.Option<ReadonlySet<string>>>>();

  const startExecutor = async (): Promise<RuntimeExecutor> => {
    const openedHandle = await openRuntimeServer(input);
    handle = Option.some(openedHandle);
    return createRuntimeExecutor(openedHandle, input, registry);
  };

  const ensureExecutor = async (): Promise<RuntimeExecutor> => {
    const executorPromise = Option.getOrElse(pending, async () => {
      const next = startExecutor();
      pending = Option.some(next);
      return await next;
    });
    return await executorPromise;
  };

  const queryAvailableModels = async (): Promise<
    Option.Option<ReadonlySet<string>>
  > => {
    const [executorResult] = await Promise.allSettled([ensureExecutor()]);
    if (executorResult.status === "rejected" || Option.isNone(handle)) {
      return NO_AVAILABLE_MODELS;
    }
    const [modelsResult] = await Promise.allSettled([
      queryAvailableOpencodeModels(handle.value.client),
    ]);
    return modelsResult.status === "fulfilled"
      ? Option.some(modelsResult.value)
      : NO_AVAILABLE_MODELS;
  };

  const resolveAvailableModels = async (): Promise<
    Option.Option<ReadonlySet<string>>
  > => {
    const modelsPromise = Option.getOrElse(availableModelsPending, async () => {
      const next = queryAvailableModels();
      availableModelsPending = Option.some(next);
      return await next;
    });
    return await modelsPromise;
  };

  return {
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
  };
};

const openOpencodeRuntimeEffect = (
  input: OpencodeRuntimeLeaseInput
): Effect.Effect<
  OpenedOpencodeRuntime,
  unknown,
  OpencodeRuntimeServerService
> =>
  Effect.gen(function* effectBody() {
    const registry = createOpencodeSessionRegistry();
    const server = yield* OpencodeRuntimeServerService;
    const handle = yield* server.open(input);
    const availableModels = yield* queryAvailableOpencodeModelsEffect(
      handle.client
    );
    return {
      availableModels,
      executor: createRuntimeExecutor(handle, input, registry),
      handle,
    };
  });

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
  await Promise.resolve(createOpencodeRuntimeLease(input));

const runWithLeasedOpencode = <T>(
  options: PipelineRuntimeOptions,
  config: PipelineConfig,
  worktreePath: string,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>
): Effect.Effect<T, unknown> =>
  Effect.provide(
    Effect.scoped(
      Effect.gen(function* effectBody() {
        const runtime = yield* Effect.acquireRelease(
          openOpencodeRuntimeEffect({
            config,
            ...(options.reporter === undefined
              ? {}
              : { onSession: opencodeSessionReporter(options.reporter) }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            worktreePath,
          }),
          (runtimeLease) =>
            Effect.tryPromise({
              catch: (error) => error,
              try: async () => {
                await runtimeLease.handle.close();
              },
            }).pipe(Effect.orDie)
        );
        return yield* run({
          ...options,
          config,
          executor: runtime.executor,
          ...(Option.isSome(runtime.availableModels)
            ? { availableModels: runtime.availableModels.value }
            : {}),
        });
      })
    ),
    OpencodeRuntimeServerServiceLive
  );

export const withOpencodeRuntime = <T>(
  options: PipelineRuntimeOptions,
  run: (resolved: PipelineRuntimeOptions) => Effect.Effect<T, unknown>
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
