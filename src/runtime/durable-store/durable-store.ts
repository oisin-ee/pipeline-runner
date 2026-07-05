import { Option } from "effect";

import type { AcceptanceCriterion, RuntimeNodeResult } from "../contracts";
import { buildRunJournal } from "../run-journal";
import type { RunJournal } from "../run-journal";

/**
 * PIPE-91.1: the typed record persisted for each node execution. Carries the
 * node's inputs (opaque until the Postgres impl, 91.4, pins the schema), the
 * terminal result (outputs + exit code), and the acceptance criteria the gate
 * evaluated against. `recordedAt` is ISO-8601 wall time set by the store.
 */
export interface DurableNodeRecord {
  criteria: AcceptanceCriterion[];
  inputs: unknown;
  recordedAt: string;
  result: RuntimeNodeResult;
}

/**
 * PIPE-91.1: the persistence interface generalising {@link RunJournal}. Records
 * and queries node results keyed `(runId, nodeId)` — the two-dimensional key
 * that `RunJournal` (file-scoped) collapses to one.
 *
 * `toRunJournal` provides the back-compat adapter: any `DurableRunStore`
 * implementation can satisfy the existing {@link RunJournal} seam the scheduler
 * already consumes, so `scheduler.ts` and `pipeline-runtime.ts` stay unchanged.
 * The Postgres impl (91.4), journal cutover (91.5), and stepping CLI (91.6/91.7)
 * each consume this interface as the swappable durability seam.
 */
export interface DurableRunStore {
  /** Retrieve the full record for a `(runId, nodeId)` pair, or none if not yet recorded. */
  get(runId: string, nodeId: string): Option.Option<DurableNodeRecord>;
  /** Durably record a node's terminal result keyed by `(runId, nodeId)`. */
  record(
    runId: string,
    nodeId: string,
    entry: Omit<DurableNodeRecord, "recordedAt">
  ): void;
  /** Passed node results for a `runId` — the resume seed (mirrors `RunJournal.resumeCompleted`). */
  resumeCompleted(runId: string): RuntimeNodeResult[];
  /**
   * Return a `RunJournal` adapter that scopes this store to a single `runId`.
   * The adapter routes `record` and `resumeCompleted` through this store so the
   * scheduler receives durability without any changes to its journal seam.
   */
  toRunJournal(runId: string): RunJournal;
}

const makeBucket = (
  store: Map<string, Map<string, DurableNodeRecord>>,
  runId: string
): Map<string, DurableNodeRecord> => {
  let bucket = store.get(runId);
  if (!bucket) {
    bucket = new Map();
    store.set(runId, bucket);
  }
  return bucket;
};

/**
 * PIPE-91.1: in-memory `DurableRunStore` implementation. Byte-identical to
 * running with no store at all (nothing persists across process restarts), so it
 * is the safe zero-infra default — the same role `inMemoryRunJournal` plays for
 * the file journal. The Postgres impl (91.4) will swap this seam without
 * touching the scheduler.
 */
export const inMemoryDurableRunStore = (): DurableRunStore => {
  const store = new Map<string, Map<string, DurableNodeRecord>>();

  const passedResultsForRun = (runId: string): RuntimeNodeResult[] => {
    const bucket = store.get(runId);
    if (!bucket) {
      return [];
    }
    return [...bucket.values()]
      .filter((rec) => rec.result.status === "passed")
      .map((rec) => rec.result);
  };

  const runStore: DurableRunStore = {
    get(runId, nodeId) {
      return Option.fromUndefinedOr(store.get(runId)?.get(nodeId));
    },

    record(runId, nodeId, entry) {
      makeBucket(store, runId).set(nodeId, {
        ...entry,
        recordedAt: new Date().toISOString(),
      });
    },

    resumeCompleted(runId) {
      return passedResultsForRun(runId);
    },

    // One shared journal adapter (PIPE-94.7) over this store — record routes
    // through the step-node core, so the local scheduler and the stepping
    // engines share exactly one record path.
    toRunJournal(runId): RunJournal {
      return buildRunJournal(runStore, runId);
    },
  };
  return runStore;
};
