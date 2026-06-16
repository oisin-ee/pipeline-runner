import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeNodeResult } from "../src/runtime/contracts";
import { fileRunJournal } from "../src/runtime/run-journal";

function nodeResult(
  nodeId: string,
  status: RuntimeNodeResult["status"]
): RuntimeNodeResult {
  return {
    attempts: 1,
    evidence: [],
    exitCode: status === "passed" ? 0 : 1,
    nodeId,
    output: status,
    status,
  };
}

describe("fileRunJournal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-journal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing for a run that has not been journaled", () => {
    expect(
      fileRunJournal(join(dir, "missing.jsonl")).resumeCompleted()
    ).toEqual([]);
  });

  it("resumes only passed results, in record order", () => {
    const journal = fileRunJournal(join(dir, "order.jsonl"));
    journal.record(nodeResult("a", "passed"));
    journal.record(nodeResult("b", "failed"));
    journal.record(nodeResult("c", "passed"));

    expect(journal.resumeCompleted().map((r) => r.nodeId)).toEqual(["a", "c"]);
  });

  it("durably round-trips passed results across a fresh journal handle", () => {
    const path = join(dir, "run.jsonl");
    const writer = fileRunJournal(path);
    writer.record(nodeResult("a", "passed"));
    writer.record(nodeResult("b", "failed"));

    // A new handle (as after a crash/restart) reads the same file.
    const reader = fileRunJournal(path);
    expect(reader.resumeCompleted().map((r) => r.nodeId)).toEqual(["a"]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
