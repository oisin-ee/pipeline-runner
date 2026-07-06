import { Effect } from "effect";
import type { Scope } from "effect";

import { loadMokaDbUrl, requireMokaDbUrl } from "../moka-global-config";
import { migratePostgresSubstrate } from "../runtime/durable-store/postgres/migrate-substrate";
import type { MokaRunManifest } from "./contracts";
import { postgresRunControlStore } from "./postgres/postgres-run-control-store";
import {
  createRunEffect,
  listRunsEffect,
  publishScheduleEffect,
  readRunEffect,
  recordEventEffect,
  updateNodeSessionEffect,
  updateNodeStatusEffect,
  updateRunControllerEffect,
  updateRunStatusEffect,
  writeNodeArtifactEffect,
} from "./store";
import { runControlStatusPaths } from "./store-paths";
import type {
  CreateRunInput,
  NodeArtifactReference,
  PublishScheduleInput,
  ReadRunInput,
  RecordEventInput,
  RunControlStatusPaths,
  UpdateNodeSessionInput,
  UpdateNodeStatusInput,
  UpdateRunControllerInput,
  UpdateRunStatusInput,
  WriteNodeArtifactInput,
} from "./store-types";

/**
 * PIPE-91.10: the swappable persistence seam for the run-control store.
 *
 * Run-control is an EVENT-SOURCED manifest store — distinct in shape from the
 * PIPE-91.1 durable run-store (which keys (runId,nodeId) node records carrying
 * inputs+outputs+criteria). Here `createRun` writes a manifest, `recordEvent`
 * appends to an event log, and `readRun`/`listRuns` reconstruct the manifest by
 * replaying that log. Because the shape differs it carries its own contract.
 *
 * The interface generalizes the file-backed functions in `./store`:
 * `fileRunControlStore` remains the explicit legacy/test adapter for today's
 * `.pipeline/runs` filesystem layout. The Postgres impl (PIPE-91.11) and the
 * cutover (PIPE-91.12) implement/consume the same seam without touching the
 * Effect scheduler or the run-control command surface.
 *
 * Storage configuration (the workspace root for the filesystem impl, a database
 * connection for the Postgres impl) is bound when the store is constructed, so
 * the method signatures stay storage-agnostic.
 */
export interface RunControlStore {
  /** Write a new run manifest, status file, event log and node directories. */
  createRun(input: CreateRunRequest): Effect.Effect<MokaRunManifest, unknown>;
  /** All runs, manifests reconstructed by replaying each event log. */
  listRuns(): Effect.Effect<MokaRunManifest[], unknown>;
  /** Publish the final schedule once and add its executable node ids. */
  publishSchedule(input: PublishScheduleRequest): Effect.Effect<MokaRunManifest, unknown>;
  /** A single run's manifest reconstructed by replaying its event log. */
  readRun(input: ReadRunRequest): ReturnType<typeof readRunEffect>;
  /** Append one event to the run's log (the event-sourcing write path). */
  recordEvent(input: RecordEventRequest): Effect.Effect<void, unknown>;
  /** Storage locators (events/manifest/status) recorded in the controller. */
  statusPaths(input: ReadRunRequest): RunControlStatusPaths;
  /** Record a node's session id alongside its status. */
  updateNodeSession(input: UpdateNodeSessionRequest): Effect.Effect<void, unknown>;
  /** Append a node-status event (convenience over `recordEvent`). */
  updateNodeStatus(input: UpdateNodeStatusRequest): Effect.Effect<void, unknown>;
  /** Persist the supervising controller process metadata onto the manifest. */
  updateRunController(input: UpdateRunControllerRequest): Effect.Effect<MokaRunManifest, unknown>;
  /** Append a run-status event (convenience over `recordEvent`). */
  updateRunStatus(input: UpdateRunStatusRequest): Effect.Effect<void, unknown>;
  /** Persist a node artifact and return its locator. */
  writeNodeArtifact(input: WriteNodeArtifactRequest): Effect.Effect<NodeArtifactReference, unknown>;
}

export type CreateRunRequest = Omit<CreateRunInput, "workspaceRoot">;
export type PublishScheduleRequest = Omit<PublishScheduleInput, "workspaceRoot">;
export type ReadRunRequest = Omit<ReadRunInput, "workspaceRoot">;
export type RecordEventRequest = Omit<RecordEventInput, "workspaceRoot">;
export type UpdateRunControllerRequest = Omit<UpdateRunControllerInput, "workspaceRoot">;
export type UpdateRunStatusRequest = Omit<UpdateRunStatusInput, "workspaceRoot">;
export type UpdateNodeStatusRequest = Omit<UpdateNodeStatusInput, "workspaceRoot">;
export type UpdateNodeSessionRequest = Omit<UpdateNodeSessionInput, "workspaceRoot">;
export type WriteNodeArtifactRequest = Omit<WriteNodeArtifactInput, "workspaceRoot">;

/**
 * Explicit filesystem-backed `RunControlStore` for legacy/test fixtures.
 * Delegates 1:1 to the Effect-returning functions in `./store`, binding
 * `workspaceRoot` so every call keeps the existing `.pipeline/runs` on-disk
 * behaviour byte-identical.
 */
export const fileRunControlStore = (workspaceRoot: string): RunControlStore => {
  const withRoot = <T>(input: T): T & { workspaceRoot: string } => ({
    ...input,
    workspaceRoot,
  });

  return {
    createRun: (input) => createRunEffect(withRoot(input)),
    listRuns: () => listRunsEffect({ workspaceRoot }),
    publishSchedule: (input) => publishScheduleEffect(withRoot(input)),
    readRun: (input) => readRunEffect(withRoot(input)),
    recordEvent: (input) => recordEventEffect(withRoot(input)),
    statusPaths: (input) => runControlStatusPaths(withRoot(input)),
    updateNodeSession: (input) => updateNodeSessionEffect(withRoot(input)),
    updateNodeStatus: (input) => updateNodeStatusEffect(withRoot(input)),
    updateRunController: (input) => updateRunControllerEffect(withRoot(input)),
    updateRunStatus: (input) => updateRunStatusEffect(withRoot(input)),
    writeNodeArtifact: (input) => writeNodeArtifactEffect(withRoot(input)),
  };
};

/**
 * PIPE-91.12/91.18: the single store-selection point. `db.url` presence is the
 * durable-substrate switch (mirroring the PIPE-91.5 journal cutover): set →
 * the Postgres store from PIPE-91.11; absent → `db.url-required` before any
 * runtime-state store is selected. Selection is the only place the substrate is
 * chosen, so the run-control command surface and the scheduler stay
 * storage-agnostic behind the PIPE-91.10 seam.
 *
 * The Postgres store owns a connection pool, so it is acquired as a scoped
 * resource and released (`close`) on scope exit — every consumer that resolves
 * the store inside an `Effect.scoped` boundary releases its connection exactly
 * once, exactly as `acquireRunJournal` does for the durable journal. The
 * filesystem store holds no resources, so it is returned directly.
 */
export const resolveRunControlStore = (
  dbUrl: ReturnType<typeof loadMokaDbUrl>,
  _workspaceRoot: string,
): Effect.Effect<RunControlStore, unknown, Scope.Scope> =>
  requireMokaDbUrl(dbUrl).pipe(
    Effect.flatMap((requiredDbUrl) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await migratePostgresSubstrate(requiredDbUrl);
        },
      }).pipe(
        Effect.flatMap(() =>
          Effect.acquireRelease(
            Effect.sync(() => postgresRunControlStore(requiredDbUrl)),
            (store) =>
              Effect.promise(async () => {
                await store.close();
              }),
          ),
        ),
      ),
    ),
  );

/**
 * PIPE-91.14: the single store-lifecycle wrapper shared by every run-control
 * entrypoint (read commands AND live-run writers). It is the only owner of the
 * `db.url` substrate switch: it reads `db.url` once via {@link loadMokaDbUrl},
 * resolves the store through {@link resolveRunControlStore}, runs `use` against
 * it inside an `Effect.scoped` boundary, and releases the Postgres connection on
 * scope exit — exactly as `acquireRunJournal` does for the durable journal.
 * Writers (supervisor, runtime reporter, detached/local run setup) wrap their
 * whole run inside this so the resolved store stays alive across the run and is
 * closed exactly once afterwards, with no per-writer `db.url` branching.
 */
export const withRunControlStoreScoped = <A>(
  workspaceRoot: string,
  use: (store: RunControlStore) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> =>
  Effect.scoped(resolveRunControlStore(loadMokaDbUrl(), workspaceRoot).pipe(Effect.flatMap(use)));
