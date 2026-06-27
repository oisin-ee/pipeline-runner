import { Effect } from "effect";
import type { MokaRunManifest } from "../src/run-control/contracts";
import {
  createRunEffect,
  listRunsEffect,
  readRunEffect,
  recordEventEffect,
  updateNodeSessionEffect,
  updateNodeStatusEffect,
  updateRunControllerEffect,
  updateRunStatusEffect,
  writeNodeArtifactEffect,
} from "../src/run-control/store";
import type {
  CreateRunInput,
  NodeArtifactReference,
  ReadRunInput,
  RecordEventInput,
  StoreContext,
  UpdateNodeSessionInput,
  UpdateNodeStatusInput,
  UpdateRunControllerInput,
  UpdateRunStatusInput,
  WriteNodeArtifactInput,
} from "../src/run-control/store-types";

export function createRun(input: CreateRunInput): Promise<MokaRunManifest> {
  return Effect.runPromise(createRunEffect(input));
}

export function updateRunController(
  input: UpdateRunControllerInput
): Promise<MokaRunManifest> {
  return Effect.runPromise(updateRunControllerEffect(input));
}

export function recordEvent(input: RecordEventInput): Promise<void> {
  return Effect.runPromise(recordEventEffect(input));
}

export function updateRunStatus(input: UpdateRunStatusInput): Promise<void> {
  return Effect.runPromise(updateRunStatusEffect(input));
}

export function updateNodeStatus(input: UpdateNodeStatusInput): Promise<void> {
  return Effect.runPromise(updateNodeStatusEffect(input));
}

export function updateNodeSession(
  input: UpdateNodeSessionInput
): Promise<void> {
  return Effect.runPromise(updateNodeSessionEffect(input));
}

export function writeNodeArtifact(
  input: WriteNodeArtifactInput
): Promise<NodeArtifactReference> {
  return Effect.runPromise(writeNodeArtifactEffect(input));
}

export function readRun(
  input: ReadRunInput
): Promise<MokaRunManifest | undefined> {
  return Effect.runPromise(readRunEffect(input));
}

export function listRuns(input: StoreContext): Promise<MokaRunManifest[]> {
  return Effect.runPromise(listRunsEffect(input));
}
