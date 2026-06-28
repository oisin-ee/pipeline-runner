import { Effect } from "effect";
import type { RuntimeNodeResult } from "./contracts";
import type { DurableRunStore } from "./durable-store/durable-store";
import {
  RunJournalFileService,
  RunJournalFileServiceLive,
} from "./services/run-journal-file-service";
import { recordNodeResult } from "./step/step-node";

/**
 * PIPE-83.10: a durable record of terminal node results for a run, so a killed
 * run resumes from the last completed node without re-running — or re-spending
 * tokens on — finished work.
 *
 * The interface is the swappable durability seam: `inMemoryRunJournal` is the
 * default and is byte-identical to running with no journal at all, while
 * `fileRunJournal` gives crash-resume with zero external infra (an append-only
 * JSONL log of node Exits). A future @effect/workflow / cluster provider can
 * implement the same seam without touching the scheduler.
 */
export interface RunJournal {
  /** Durably record a node's terminal result. */
  record(result: RuntimeNodeResult): void;
  /** Passed node results already recorded for this run — the resume seed. */
  resumeCompleted(): RuntimeNodeResult[];
}

function passedOnly(results: RuntimeNodeResult[]): RuntimeNodeResult[] {
  // Resume only past the last successfully completed node: a failed (or any
  // non-passed) node and everything downstream is re-run, so blocked-descendant
  // and fail-fast handling stay live on replay.
  return results.filter((result) => result.status === "passed");
}

function parseJournalText(text: string | undefined): RuntimeNodeResult[] {
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RuntimeNodeResult);
}

function recordJournalEffect(
  path: string,
  result: RuntimeNodeResult
): Effect.Effect<void, unknown, RunJournalFileService> {
  return Effect.gen(function* () {
    const files = yield* RunJournalFileService;
    yield* files.appendLine(path, `${JSON.stringify(result)}\n`);
  });
}

function resumeCompletedEffect(
  path: string
): Effect.Effect<RuntimeNodeResult[], unknown, RunJournalFileService> {
  return Effect.gen(function* () {
    const files = yield* RunJournalFileService;
    const text = yield* files.readTextIfExists(path);
    return passedOnly(parseJournalText(text));
  });
}

/**
 * PIPE-94.7: build the scheduler's RunJournal seam over a DurableRunStore,
 * routing record through the step-node core's recordNodeResult (the single owner
 * of the terminal-result write shape) and resume through the store. Both
 * DurableRunStore impls' `toRunJournal` delegate here, so there is exactly one
 * journal-adapter implementation rather than a copy per store.
 */
export function buildRunJournal(
  store: DurableRunStore,
  runId: string
): RunJournal {
  return {
    record: (result) => recordNodeResult({ result, runId, store }),
    resumeCompleted: () => store.resumeCompleted(runId),
  };
}

export function fileRunJournal(path: string): RunJournal {
  return {
    record: (result) =>
      Effect.runSync(
        Effect.provide(
          recordJournalEffect(path, result),
          RunJournalFileServiceLive
        )
      ),
    resumeCompleted: () =>
      Effect.runSync(
        Effect.provide(resumeCompletedEffect(path), RunJournalFileServiceLive)
      ),
  };
}
