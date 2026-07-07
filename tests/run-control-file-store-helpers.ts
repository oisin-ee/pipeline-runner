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

export const createRun = async (
  input: CreateRunInput
): Promise<MokaRunManifest> => await Effect.runPromise(createRunEffect(input));

export const updateRunController = async (
  input: UpdateRunControllerInput
): Promise<MokaRunManifest> =>
  await Effect.runPromise(updateRunControllerEffect(input));

export const recordEvent = async (input: RecordEventInput): Promise<void> => {
  await Effect.runPromise(recordEventEffect(input));
};

export const updateRunStatus = async (
  input: UpdateRunStatusInput
): Promise<void> => {
  await Effect.runPromise(updateRunStatusEffect(input));
};

export const updateNodeStatus = async (
  input: UpdateNodeStatusInput
): Promise<void> => {
  await Effect.runPromise(updateNodeStatusEffect(input));
};

export const updateNodeSession = async (
  input: UpdateNodeSessionInput
): Promise<void> => {
  await Effect.runPromise(updateNodeSessionEffect(input));
};

export const writeNodeArtifact = async (
  input: WriteNodeArtifactInput
): Promise<NodeArtifactReference> =>
  await Effect.runPromise(writeNodeArtifactEffect(input));

export const readRun = async (
  input: ReadRunInput
): Promise<MokaRunManifest | undefined> =>
  await Effect.runPromise(readRunEffect(input));

export const listRuns = async (
  input: StoreContext
): Promise<MokaRunManifest[]> => await Effect.runPromise(listRunsEffect(input));
