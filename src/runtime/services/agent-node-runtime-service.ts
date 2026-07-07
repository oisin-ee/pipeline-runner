import { readFileSync } from "node:fs";

import { Context, Effect, Layer } from "effect";

import { buildRepoMapContext } from "../../context/repo-map";
import type { RunnerExecutionOptions, RunnerLaunchPlan } from "../../runner";
import type { RuntimeContext } from "../contracts";

export class AgentNodeRuntimeService extends Context.Service<
  AgentNodeRuntimeService,
  {
    readonly buildRepoMap: typeof buildRepoMapContext;
    readonly executeRunner: (
      executor: RuntimeContext["executor"],
      plan: RunnerLaunchPlan,
      options: RunnerExecutionOptions
    ) => Effect.Effect<
      Awaited<ReturnType<RuntimeContext["executor"]>>,
      unknown
    >;
    readonly readText: (path: string) => Effect.Effect<string>;
  }
>()("AgentNodeRuntimeService") {}

export const AgentNodeRuntimeServiceLive = Layer.succeed(
  AgentNodeRuntimeService,
  {
    buildRepoMap: buildRepoMapContext,
    executeRunner: (executor, plan, options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => await executor(plan, options),
      }),
    readText: (path) => Effect.sync(() => readFileSync(path, "utf-8")),
  }
);
