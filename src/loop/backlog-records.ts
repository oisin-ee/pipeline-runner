import { Effect } from "effect";
import { RepoIoServiceLive } from "../runtime/services/repo-io-service";
import {
  type BacklogTaskRecord,
  loadBacklogTaskStoreEffect,
} from "../tickets/backlog-task-store";

// ===========================================================================
// PIPE-88.8 — shared backlog record loader
//
// The single owner of "read the backlog task records from a worktree" used by
// both the loop CLI precondition check and the production ControllerDeps. It
// loads the store, narrows to the records, flattens the tagged store error to a
// plain Error, and provides the RepoIo layer so callers stay layer-free.
// ===========================================================================

export function loadBacklogRecords(
  worktreePath: string
): Effect.Effect<readonly BacklogTaskRecord[], Error> {
  return loadBacklogTaskStoreEffect(worktreePath).pipe(
    Effect.map((store) => store.tasks),
    Effect.mapError((error) => new Error(error.message)),
    Effect.provide(RepoIoServiceLive)
  );
}
