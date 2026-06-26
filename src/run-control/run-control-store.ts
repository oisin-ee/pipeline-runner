import type { Effect } from "effect";
import type { MokaRunManifest } from "./contracts";
import {
  type CreateRunInput,
  createRunEffect,
  listRunsEffect,
  type NodeArtifactReference,
  type ReadRunInput,
  type RecordEventInput,
  type RunControlStatusPaths,
  readRunEffect,
  recordEventEffect,
  runControlStatusPaths,
  type UpdateNodeSessionInput,
  type UpdateNodeStatusInput,
  type UpdateRunControllerInput,
  type UpdateRunStatusInput,
  updateNodeSessionEffect,
  updateNodeStatusEffect,
  updateRunControllerEffect,
  updateRunStatusEffect,
  type WriteNodeArtifactInput,
  writeNodeArtifactEffect,
} from "./store";

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
 * `fileRunControlStore` is the default and is byte-identical to today's
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
  /** A single run's manifest reconstructed by replaying its event log. */
  readRun(
    input: ReadRunRequest
  ): Effect.Effect<MokaRunManifest | undefined, unknown>;
  /** Append one event to the run's log (the event-sourcing write path). */
  recordEvent(input: RecordEventRequest): Effect.Effect<void, unknown>;
  /** Storage locators (events/manifest/status) recorded in the controller. */
  statusPaths(input: ReadRunRequest): RunControlStatusPaths;
  /** Record a node's session id alongside its status. */
  updateNodeSession(
    input: UpdateNodeSessionRequest
  ): Effect.Effect<void, unknown>;
  /** Append a node-status event (convenience over `recordEvent`). */
  updateNodeStatus(
    input: UpdateNodeStatusRequest
  ): Effect.Effect<void, unknown>;
  /** Persist the supervising controller process metadata onto the manifest. */
  updateRunController(
    input: UpdateRunControllerRequest
  ): Effect.Effect<MokaRunManifest, unknown>;
  /** Append a run-status event (convenience over `recordEvent`). */
  updateRunStatus(input: UpdateRunStatusRequest): Effect.Effect<void, unknown>;
  /** Persist a node artifact and return its locator. */
  writeNodeArtifact(
    input: WriteNodeArtifactRequest
  ): Effect.Effect<NodeArtifactReference, unknown>;
}

export type CreateRunRequest = Omit<CreateRunInput, "workspaceRoot">;
export type ReadRunRequest = Omit<ReadRunInput, "workspaceRoot">;
export type RecordEventRequest = Omit<RecordEventInput, "workspaceRoot">;
export type UpdateRunControllerRequest = Omit<
  UpdateRunControllerInput,
  "workspaceRoot"
>;
export type UpdateRunStatusRequest = Omit<
  UpdateRunStatusInput,
  "workspaceRoot"
>;
export type UpdateNodeStatusRequest = Omit<
  UpdateNodeStatusInput,
  "workspaceRoot"
>;
export type UpdateNodeSessionRequest = Omit<
  UpdateNodeSessionInput,
  "workspaceRoot"
>;
export type WriteNodeArtifactRequest = Omit<
  WriteNodeArtifactInput,
  "workspaceRoot"
>;

/**
 * The default filesystem-backed `RunControlStore`. Delegates 1:1 to the
 * Effect-returning functions in `./store`, binding `workspaceRoot` so every call
 * keeps the existing `.pipeline/runs` on-disk behaviour byte-identical.
 */
export function fileRunControlStore(workspaceRoot: string): RunControlStore {
  const withRoot = <T>(input: T): T & { workspaceRoot: string } => ({
    ...input,
    workspaceRoot,
  });

  return {
    createRun: (input) => createRunEffect(withRoot(input)),
    listRuns: () => listRunsEffect({ workspaceRoot }),
    readRun: (input) => readRunEffect(withRoot(input)),
    recordEvent: (input) => recordEventEffect(withRoot(input)),
    statusPaths: (input) => runControlStatusPaths(withRoot(input)),
    updateNodeSession: (input) => updateNodeSessionEffect(withRoot(input)),
    updateNodeStatus: (input) => updateNodeStatusEffect(withRoot(input)),
    updateRunController: (input) => updateRunControllerEffect(withRoot(input)),
    updateRunStatus: (input) => updateRunStatusEffect(withRoot(input)),
    writeNodeArtifact: (input) => writeNodeArtifactEffect(withRoot(input)),
  };
}
