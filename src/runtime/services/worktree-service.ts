import { Context, Effect, Layer } from "effect";
import {
  type CreateWorktreeOptions,
  createChildWorktree,
  gcParallelWorktrees,
  type WorktreeLease,
  type WorktreeState,
} from "../parallel-worktrees/parallel-worktrees";

/**
 * Effect service over the git-worktree lifecycle (PIPE-83 follow-up). The Live
 * layer delegates to the synchronous porcelain helpers in parallel-worktrees;
 * the Effect-native parallel-node runtime composes `createChild`/`gc` through
 * this injectable seam instead of calling the helpers directly. This is the
 * canonical service shape for the Effect conversion: a `Context.Tag` whose Live
 * `Layer` wraps the underlying IO, provided once at the runPromise boundary.
 */
export class WorktreeService extends Context.Tag("WorktreeService")<
  WorktreeService,
  {
    readonly createChild: (
      opts: CreateWorktreeOptions
    ) => Effect.Effect<WorktreeLease>;
    readonly gc: (repoRoot: string) => Effect.Effect<WorktreeState[]>;
  }
>() {}

export const WorktreeServiceLive = Layer.succeed(WorktreeService, {
  createChild: (opts) => Effect.sync(() => createChildWorktree(opts)),
  gc: (repoRoot) => Effect.sync(() => gcParallelWorktrees(repoRoot)),
});
