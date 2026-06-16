import { Context, Effect, Layer } from "effect";
import type { RunnerExecutionOptions, RunnerLaunchPlan } from "../../runner";
import type { RuntimeContext } from "../contracts";
import { promoteWorktreeChanges } from "../parallel-worktrees/parallel-worktrees";

export class SelectCandidateService extends Context.Tag(
  "SelectCandidateService"
)<
  SelectCandidateService,
  {
    readonly executeRunner: (
      executor: RuntimeContext["executor"],
      plan: RunnerLaunchPlan,
      options: RunnerExecutionOptions
    ) => Effect.Effect<
      Awaited<ReturnType<RuntimeContext["executor"]>>,
      unknown
    >;
    readonly promoteWinner: (
      repoRoot: string,
      runId: string | undefined,
      parentNodeId: string,
      childNodeId: string
    ) => Effect.Effect<string[]>;
  }
>() {}

export const SelectCandidateServiceLive = Layer.succeed(
  SelectCandidateService,
  {
    executeRunner: (executor, plan, options) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: () => Promise.resolve(executor(plan, options)),
      }),
    promoteWinner: (repoRoot, runId, parentNodeId, childNodeId) =>
      Effect.sync(() =>
        promoteWorktreeChanges(repoRoot, runId, parentNodeId, childNodeId)
      ),
  }
);
