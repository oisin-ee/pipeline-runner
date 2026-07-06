import { Option } from "effect";
import { describe, expect, it } from "vitest";

import type { AcceptanceCriterion, RuntimeNodeResult } from "../contracts";
import type { RunJournal } from "../run-journal";
import { inMemoryDurableRunStore } from "./durable-store";

const passedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output: `output of ${nodeId}`,
  status: "passed",
});

const failedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 1"],
  exitCode: 1,
  nodeId,
  output: `output of ${nodeId}`,
  status: "failed",
});

describe("inMemoryDurableRunStore", () => {
  describe("record + get — AC1 round-trip by (runId, nodeId)", () => {
    it("round-trips a node record by (runId, nodeId)", () => {
      const store = inMemoryDurableRunStore();
      const result = passedResult("build");
      const criteria: AcceptanceCriterion[] = [{ id: "ac1", text: "must build" }];
      const inputs = { task: "build the project" };

      store.record("run-1", "build", { criteria, inputs, result });

      const retrieved = Option.getOrThrow(store.get("run-1", "build"));
      expect(retrieved.result).toEqual(result);
      expect(retrieved.criteria).toEqual(criteria);
      expect(retrieved.inputs).toEqual(inputs);
      expect(typeof retrieved.recordedAt).toBe("string");
    });

    it("returns undefined for an unrecorded (runId, nodeId) pair", () => {
      const store = inMemoryDurableRunStore();
      expect(Option.isNone(store.get("run-x", "missing"))).toBe(true);
    });

    it("isolates records across different runIds", () => {
      const store = inMemoryDurableRunStore();
      store.record("run-A", "node", {
        criteria: [],
        inputs: undefined,
        result: passedResult("node"),
      });
      expect(Option.isNone(store.get("run-B", "node"))).toBe(true);
    });

    it("overwrites an existing record when recorded again", () => {
      const store = inMemoryDurableRunStore();
      const first = passedResult("node");
      const second: RuntimeNodeResult = {
        ...passedResult("node"),
        output: "second run",
      };

      store.record("run-1", "node", {
        criteria: [],
        inputs: undefined,
        result: first,
      });
      store.record("run-1", "node", {
        criteria: [],
        inputs: undefined,
        result: second,
      });

      expect(Option.getOrThrow(store.get("run-1", "node")).result.output).toBe("second run");
    });
  });

  describe("resumeCompleted — AC2 passed-only filter mirrors RunJournal passedOnly", () => {
    it("returns only passed results (2 passed + 1 failed → 2 returned)", () => {
      const store = inMemoryDurableRunStore();
      store.record("run-1", "a", {
        criteria: [],
        inputs: undefined,
        result: passedResult("a"),
      });
      store.record("run-1", "b", {
        criteria: [],
        inputs: undefined,
        result: passedResult("b"),
      });
      store.record("run-1", "c", {
        criteria: [],
        inputs: undefined,
        result: failedResult("c"),
      });

      const resumed = store.resumeCompleted("run-1");

      expect(resumed).toHaveLength(2);
      expect(resumed.map((r) => r.nodeId).toSorted()).toEqual(["a", "b"]);
      expect(resumed.every((r) => r.status === "passed")).toBe(true);
    });

    it("returns empty array for a runId with no records", () => {
      const store = inMemoryDurableRunStore();
      expect(store.resumeCompleted("run-ghost")).toEqual([]);
    });

    it("returns empty array when all nodes failed", () => {
      const store = inMemoryDurableRunStore();
      store.record("run-1", "a", {
        criteria: [],
        inputs: undefined,
        result: failedResult("a"),
      });
      expect(store.resumeCompleted("run-1")).toEqual([]);
    });

    it("isolates resumeCompleted across runIds", () => {
      const store = inMemoryDurableRunStore();
      store.record("run-A", "node", {
        criteria: [],
        inputs: undefined,
        result: passedResult("node"),
      });
      expect(store.resumeCompleted("run-B")).toHaveLength(0);
    });
  });

  describe("toRunJournal — AC3 RunJournal seam satisfaction", () => {
    it("returns a structurally valid RunJournal", () => {
      const store = inMemoryDurableRunStore();
      const journal: RunJournal = store.toRunJournal("run-2");
      expect(typeof journal.record).toBe("function");
      expect(typeof journal.resumeCompleted).toBe("function");
    });

    it("journal.record stores the result and journal.resumeCompleted returns it", () => {
      const store = inMemoryDurableRunStore();
      const journal = store.toRunJournal("run-2");
      const result = passedResult("x");

      journal.record(result);

      expect(journal.resumeCompleted()).toEqual([result]);
    });

    it("journal.resumeCompleted filters to passed only", () => {
      const store = inMemoryDurableRunStore();
      const journal = store.toRunJournal("run-2");

      journal.record(passedResult("a"));
      journal.record(failedResult("b"));

      const resumed = journal.resumeCompleted();
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.nodeId).toBe("a");
    });

    it("journal writes are visible through store.get()", () => {
      const store = inMemoryDurableRunStore();
      const journal = store.toRunJournal("run-2");
      const result = passedResult("x");

      journal.record(result);

      expect(Option.getOrThrow(store.get("run-2", "x")).result).toEqual(result);
    });

    it("store.record() writes are visible through journal.resumeCompleted()", () => {
      const store = inMemoryDurableRunStore();
      const journal = store.toRunJournal("run-3");
      const result = passedResult("y");

      store.record("run-3", "y", { criteria: [], inputs: undefined, result });

      expect(journal.resumeCompleted()).toEqual([result]);
    });

    it("adapters for different runIds do not share state", () => {
      const store = inMemoryDurableRunStore();
      const j1 = store.toRunJournal("run-X");
      const j2 = store.toRunJournal("run-Y");

      j1.record(passedResult("node"));

      expect(j2.resumeCompleted()).toHaveLength(0);
    });
  });
});
