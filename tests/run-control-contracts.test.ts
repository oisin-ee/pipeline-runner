import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MOKA_NODE_STATUSES,
  MOKA_RUN_STATUSES,
  mokaRunEffortSchema,
  mokaRunModeSchema,
  mokaRunTargetSchema,
  parseMokaNodeStatus,
  parseMokaRunEvent,
  parseMokaRunManifest,
  parseMokaRunStatus,
  parseRunEffort,
  parseRunMode,
  parseRunTarget,
  RUN_EFFORTS,
  RUN_MODES,
  RUN_TARGETS,
  runEffortSchema,
  runModeSchema,
  runTargetSchema,
  safeParseMokaNodeStatus,
  safeParseMokaRunEvent,
  safeParseMokaRunManifest,
  safeParseMokaRunStatus,
  safeParseRunEffort,
  safeParseRunMode,
  safeParseRunTarget,
} from "../src/run-control/contracts";
import type {
  MokaNodeStatus,
  MokaRunEvent,
  MokaRunManifest,
  MokaRunStatus,
  RunEffort,
  RunMode,
  RunTarget,
} from "../src/run-control/contracts";

describe("run-control contracts", () => {
  it("pins the accepted run selector values and public type aliases", () => {
    expect(RUN_TARGETS).toEqual(["local", "remote"]);
    expect(RUN_EFFORTS).toEqual(["quick", "normal", "thorough"]);
    expect(RUN_MODES).toEqual(["read-only", "write"]);

    expect(parseRunTarget("local")).toBe("local");
    expect(parseRunTarget("remote")).toBe("remote");
    expect(parseRunEffort("quick")).toBe("quick");
    expect(parseRunEffort("normal")).toBe("normal");
    expect(parseRunEffort("thorough")).toBe("thorough");
    expect(parseRunMode("read-only")).toBe("read-only");
    expect(parseRunMode("write")).toBe("write");

    expect(safeParseRunTarget("cluster").ok).toBe(false);
    expect(safeParseRunEffort("slow").ok).toBe(false);
    expect(safeParseRunMode("read-write").ok).toBe(false);
    expect(() => parseRunTarget("cluster")).toThrow();
    expect(() => parseRunEffort("slow")).toThrow();
    expect(() => parseRunMode("read-write")).toThrow();

    expect(mokaRunTargetSchema).toBe(runTargetSchema);
    expect(mokaRunEffortSchema).toBe(runEffortSchema);
    expect(mokaRunModeSchema).toBe(runModeSchema);
    expectTypeOf<RunTarget>().toEqualTypeOf<"local" | "remote">();
    expectTypeOf<RunEffort>().toEqualTypeOf<"normal" | "quick" | "thorough">();
    expectTypeOf<RunMode>().toEqualTypeOf<"read-only" | "write">();
  });

  it("pins run and node status vocabularies with parser and safe-parser helpers", () => {
    const expectedStatuses = [
      "queued",
      "starting",
      "running",
      "stalled",
      "passed",
      "failed",
      "timed_out",
      "aborted",
      "blocked",
    ];

    expect(MOKA_RUN_STATUSES).toEqual(expectedStatuses);
    expect(MOKA_NODE_STATUSES).toEqual(expectedStatuses);

    for (const status of expectedStatuses) {
      expect(parseMokaRunStatus(status)).toBe(status);
      expect(parseMokaNodeStatus(status)).toBe(status);
      expect(safeParseMokaRunStatus(status).ok).toBe(true);
      expect(safeParseMokaNodeStatus(status).ok).toBe(true);
    }

    expect(safeParseMokaRunStatus("cancelled").ok).toBe(false);
    expect(safeParseMokaNodeStatus("cancelled").ok).toBe(false);
    expect(() => parseMokaRunStatus("cancelled")).toThrow();
    expect(() => parseMokaNodeStatus("cancelled")).toThrow();
    expectTypeOf<MokaRunStatus>().toEqualTypeOf<MokaNodeStatus>();
  });

  it("validates strict discriminated run-control events", () => {
    const runStatusEvent = {
      at: "2026-06-16T12:00:00.000Z",
      status: "running",
      type: "run.status",
    };
    const nodeStatusEvent = {
      at: "2026-06-16T12:00:01.000Z",
      nodeId: "test-writer",
      status: "passed",
      type: "node.status",
    };

    expect(parseMokaRunEvent(runStatusEvent)).toEqual(runStatusEvent);
    expect(parseMokaRunEvent(nodeStatusEvent)).toEqual(nodeStatusEvent);
    expect(safeParseMokaRunEvent(runStatusEvent).ok).toBe(true);
    expect(safeParseMokaRunEvent(nodeStatusEvent).ok).toBe(true);

    expect(
      safeParseMokaRunEvent({ ...runStatusEvent, nodeId: "extra" }).ok
    ).toBe(false);
    expect(
      safeParseMokaRunEvent({ ...nodeStatusEvent, detail: "extra" }).ok
    ).toBe(false);
    expect(safeParseMokaRunEvent({ ...nodeStatusEvent, nodeId: "" }).ok).toBe(
      false
    );
    expect(safeParseMokaRunEvent({ ...runStatusEvent, at: "" }).ok).toBe(false);
    expect(
      safeParseMokaRunEvent({ ...runStatusEvent, status: "done" }).ok
    ).toBe(false);
    expect(safeParseMokaRunEvent({ ...runStatusEvent, type: "log" }).ok).toBe(
      false
    );
    expect(() =>
      parseMokaRunEvent({ ...runStatusEvent, nodeId: "extra" })
    ).toThrow();
    expectTypeOf<MokaRunEvent>().toExtend<
      | { at: string; status: MokaRunStatus; type: "run.status" }
      | {
          at: string;
          nodeId: string;
          status: MokaNodeStatus;
          type: "node.status";
        }
    >();
    expect(parseMokaRunEvent(runStatusEvent).type).toBe("run.status");
    expect(parseMokaRunEvent(nodeStatusEvent).type).toBe("node.status");
  });

  it("validates strict run manifests with node state and event history", () => {
    const manifest = {
      effort: "quick",
      events: [
        {
          at: "2026-06-16T12:00:00.000Z",
          status: "running",
          type: "run.status",
        },
        {
          at: "2026-06-16T12:00:01.000Z",
          nodeId: "test-writer",
          status: "passed",
          type: "node.status",
        },
      ],
      mode: "read-only",
      nodes: {
        "code-writer": "queued",
        "test-writer": "passed",
      },
      runId: "run-123",
      status: "running",
      target: "local",
    };

    expect(parseMokaRunManifest(manifest)).toEqual(manifest);
    expect(safeParseMokaRunManifest(manifest).ok).toBe(true);

    expect(safeParseMokaRunManifest({ ...manifest, extra: true }).ok).toBe(
      false
    );
    expect(safeParseMokaRunManifest({ ...manifest, runId: "" }).ok).toBe(false);
    expect(
      safeParseMokaRunManifest({ ...manifest, target: "cluster" }).ok
    ).toBe(false);
    expect(safeParseMokaRunManifest({ ...manifest, effort: "slow" }).ok).toBe(
      false
    );
    expect(
      safeParseMokaRunManifest({ ...manifest, mode: "read-write" }).ok
    ).toBe(false);
    expect(safeParseMokaRunManifest({ ...manifest, status: "done" }).ok).toBe(
      false
    );
    expect(
      safeParseMokaRunManifest({
        ...manifest,
        nodes: { "test-writer": "done" },
      }).ok
    ).toBe(false);
    expect(
      safeParseMokaRunManifest({
        ...manifest,
        events: [{ type: "run.status" }],
      }).ok
    ).toBe(false);
    expect(() => parseMokaRunManifest({ ...manifest, extra: true })).toThrow();
    expectTypeOf<MokaRunManifest>().toExtend<{
      effort: RunEffort;
      events: MokaRunEvent[];
      mode: RunMode;
      nodes: Record<string, MokaNodeStatus>;
      runId: string;
      status: MokaRunStatus;
      target: RunTarget;
    }>();
    expect(parseMokaRunManifest(manifest).events).toEqual(manifest.events);
    expect(MOKA_NODE_STATUSES).toEqual(MOKA_RUN_STATUSES);
  });
});
