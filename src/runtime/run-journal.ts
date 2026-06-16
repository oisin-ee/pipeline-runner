import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeNodeResult } from "./contracts";

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

function readJournalFile(path: string): RuntimeNodeResult[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RuntimeNodeResult);
}

export function fileRunJournal(path: string): RunJournal {
  return {
    record: (result) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(result)}\n`);
    },
    resumeCompleted: () => passedOnly(readJournalFile(path)),
  };
}
