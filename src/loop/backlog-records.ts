import { Effect } from "effect";

import { RepoIoServiceLive } from "../runtime/services/repo-io-service";
import { loadBacklogTaskStoreEffect } from "../tickets/backlog-task-store";
import type { BacklogTaskRecord } from "../tickets/backlog-task-store";

const backlogStoreError = (error: { readonly message: string }): Error =>
  new Error(error.message);

// ===========================================================================
// PIPE-88.8 — shared backlog record loader
//
// The single owner of "read the backlog task records from a worktree" used by
// both the loop CLI precondition check and the production ControllerDeps. It
// loads the store, narrows to the records, flattens the tagged store error to a
// plain Error, and provides the RepoIo layer so callers stay layer-free.
// ===========================================================================

export const loadBacklogRecords = (
  worktreePath: string
): Effect.Effect<readonly BacklogTaskRecord[], Error> =>
  loadBacklogTaskStoreEffect(worktreePath).pipe(
    Effect.map((store) => store.tasks),
    Effect.mapError(backlogStoreError),
    Effect.provide(RepoIoServiceLive)
  );
