import { describe, expect, expectTypeOf, it } from "vitest";

import {
  MOKA_NODE_STATUSES,
  MOKA_RUN_STATUSES,
  mokaNodeStatusSchema,
  mokaRunEffortSchema,
  mokaRunEventSchema,
  mokaRunManifestSchema,
  mokaRunModeSchema,
  mokaRunStatusSchema,
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

    expect(safeParseRunTarget("cluster").success).toBe(false);
    expect(safeParseRunEffort("slow").success).toBe(false);
    expect(safeParseRunMode("read-write").success).toBe(false);
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
      expect(safeParseMokaRunStatus(status).success).toBe(true);
      expect(safeParseMokaNodeStatus(status).success).toBe(true);
    }

    expect(safeParseMokaRunStatus("cancelled").success).toBe(false);
    expect(safeParseMokaNodeStatus("cancelled").success).toBe(false);
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
    expect(safeParseMokaRunEvent(runStatusEvent).success).toBe(true);
    expect(safeParseMokaRunEvent(nodeStatusEvent).success).toBe(true);

    expect(
      safeParseMokaRunEvent({ ...runStatusEvent, nodeId: "extra" }).success
    ).toBe(false);
    expect(
      safeParseMokaRunEvent({ ...nodeStatusEvent, detail: "extra" }).success
    ).toBe(false);
    expect(
      safeParseMokaRunEvent({ ...nodeStatusEvent, nodeId: "" }).success
    ).toBe(false);
    expect(safeParseMokaRunEvent({ ...runStatusEvent, at: "" }).success).toBe(
      false
    );
    expect(
      safeParseMokaRunEvent({ ...runStatusEvent, status: "done" }).success
    ).toBe(false);
    expect(
      safeParseMokaRunEvent({ ...runStatusEvent, type: "log" }).success
    ).toBe(false);
    expect(() =>
      parseMokaRunEvent({ ...runStatusEvent, nodeId: "extra" })
    ).toThrow();
    expectTypeOf<MokaRunEvent>().toMatchTypeOf<
      | { at: string; status: MokaRunStatus; type: "run.status" }
      | {
          at: string;
          nodeId: string;
          status: MokaNodeStatus;
          type: "node.status";
        }
    >();
    expect(mokaRunEventSchema.options).toHaveLength(2);
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
    expect(safeParseMokaRunManifest(manifest).success).toBe(true);

    expect(safeParseMokaRunManifest({ ...manifest, extra: true }).success).toBe(
      false
    );
    expect(safeParseMokaRunManifest({ ...manifest, runId: "" }).success).toBe(
      false
    );
    expect(
      safeParseMokaRunManifest({ ...manifest, target: "cluster" }).success
    ).toBe(false);
    expect(
      safeParseMokaRunManifest({ ...manifest, effort: "slow" }).success
    ).toBe(false);
    expect(
      safeParseMokaRunManifest({ ...manifest, mode: "read-write" }).success
    ).toBe(false);
    expect(
      safeParseMokaRunManifest({ ...manifest, status: "done" }).success
    ).toBe(false);
    expect(
      safeParseMokaRunManifest({
        ...manifest,
        nodes: { "test-writer": "done" },
      }).success
    ).toBe(false);
    expect(
      safeParseMokaRunManifest({
        ...manifest,
        events: [{ type: "run.status" }],
      }).success
    ).toBe(false);
    expect(() => parseMokaRunManifest({ ...manifest, extra: true })).toThrow();
    expectTypeOf<MokaRunManifest>().toMatchTypeOf<{
      effort: RunEffort;
      events: MokaRunEvent[];
      mode: RunMode;
      nodes: Record<string, MokaNodeStatus>;
      runId: string;
      status: MokaRunStatus;
      target: RunTarget;
    }>();
    expect(mokaRunManifestSchema.shape.events.element).toBe(mokaRunEventSchema);
    expect(mokaRunManifestSchema.shape.status).toBe(mokaRunStatusSchema);
    expect(mokaRunManifestSchema.shape.target).toBe(runTargetSchema);
    expect(mokaRunManifestSchema.shape.effort).toBe(runEffortSchema);
    expect(mokaRunManifestSchema.shape.mode).toBe(runModeSchema);
    expect(mokaNodeStatusSchema.options).toEqual(MOKA_NODE_STATUSES);
  });
});
