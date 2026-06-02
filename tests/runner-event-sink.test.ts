import { describe, expect, it, vi } from "vitest";

const EVENT_SINK_URL = "https://console.example.test/api/runs/run_123/events";
const TIMESTAMP = "2026-06-02T09:00:00.000Z";
const CONSOLE_UNAVAILABLE_RE = /console unavailable/i;

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
  } as Response;
}

function responseWithStatus(status: number): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(`status ${status}`),
  } as Response;
}

function loadSinkModule(): Promise<Record<string, any>> {
  return import("../src/runner-event-sink.js");
}

function loadContractModule(): Promise<Record<string, any>> {
  return import("../src/runner-job-contract.js");
}

function parseBodies(fetchMock: ReturnType<typeof vi.fn>): any[] {
  return fetchMock.mock.calls.map(([, init]) =>
    JSON.parse(String((init as RequestInit).body))
  );
}

describe("runner event sink", () => {
  it("uses injected fetch, assigns integer sequences from 1, batches, adds auth, and supplies timestamps", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(async () => okResponse());
    const sink = createRunnerEventSink({
      authHeader: "Authorization",
      authToken: "console-token",
      batchSize: 2,
      fetch: fetchMock,
      now: () => new Date(TIMESTAMP),
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordRuntimeEvent({
      attempt: 1,
      nodeId: "red",
      profile: "pipeline-test-writer",
      runnerId: "codex",
      type: "node.start",
    });
    sink.recordRuntimeEvent({
      evidence: ["failed as expected"],
      gateId: "RED",
      kind: "command",
      nodeId: "red",
      passed: false,
      type: "gate.finish",
    });
    sink.recordRuntimeEvent({
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "default",
    });

    await sink.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      EVENT_SINK_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer console-token",
          "Content-Type": "application/json",
        }),
        method: "POST",
      })
    );
    expect(parseBodies(fetchMock)).toEqual([
      {
        events: [
          {
            node: {
              attempt: 1,
              nodeId: "red",
              profile: "pipeline-test-writer",
              runnerId: "codex",
              status: "running",
            },
            at: TIMESTAMP,
            sequence: 1,
            type: "node.start",
          },
          {
            gate: {
              evidence: ["failed as expected"],
              gateId: "RED",
              kind: "command",
              label: "RED",
              nodeId: "red",
              passed: false,
              status: "failed",
            },
            at: TIMESTAMP,
            sequence: 2,
            type: "gate.finish",
          },
        ],
      },
      {
        events: [
          {
            finalResult: {
              outcome: "PASS",
              workflowId: "default",
            },
            at: TIMESTAMP,
            sequence: 3,
            type: "workflow.finish",
          },
        ],
      },
    ]);
  });

  it("retries retryable HTTP and network failures before succeeding", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responseWithStatus(503))
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
      maxRetries: 2,
      retryDelayMs: 0,
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordRuntimeEvent({
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "default",
    });

    await sink.flush();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    401, 403,
  ])("treats %i as a terminal event sink authorization failure", async (status) => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(async () => responseWithStatus(status));
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
      maxRetries: 3,
      retryDelayMs: 0,
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordRuntimeEvent({
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "default",
    });

    await expect(sink.flush()).rejects.toThrow(
      new RegExp(`event sink.*${status}`, "i")
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flushes batches in the same order events were recorded", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(async () => okResponse());
    const sink = createRunnerEventSink({
      batchSize: 2,
      fetch: fetchMock,
      authToken: "console-token",
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    for (const nodeId of ["red", "green", "verify", "review"]) {
      sink.recordRuntimeEvent({
        attempt: 1,
        exitCode: 0,
        nodeId,
        status: "passed",
        type: "node.finish",
      });
    }

    await sink.flush();

    expect(
      parseBodies(fetchMock).flatMap((body) =>
        body.events.map((event: { sequence: number }) => event.sequence)
      )
    ).toEqual([1, 2, 3, 4]);
    expect(
      parseBodies(fetchMock).flatMap((body) =>
        body.events.map(
          (event: { node: { nodeId: string } }) => event.node.nodeId
        )
      )
    ).toEqual(["red", "green", "verify", "review"]);
  });

  it("maps runtime events to the top-level fields consumed by console", async () => {
    const { mapRuntimeEventToRunnerEventRecords } = await loadContractModule();
    const singleRecord = (event: Record<string, unknown>) => {
      const records = mapRuntimeEventToRunnerEventRecords(event, {
        runId: "run_123",
        sequence: 1,
        timestamp: TIMESTAMP,
      });
      expect(records).toHaveLength(1);
      return records[0];
    };

    expect(
      mapRuntimeEventToRunnerEventRecords(
        {
          edges: [{ source: "red", target: "green" }],
          nodes: [{ id: "red", kind: "agent", needs: [] }],
          type: "workflow.planned",
          workflowId: "default",
        },
        { runId: "run_123", sequence: 1, timestamp: TIMESTAMP }
      )
    ).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "workflow.planned",
        workflowPlan: {
          workflowId: "default",
          edges: [{ source: "red", target: "green" }],
          nodes: [{ id: "red", kind: "agent", needs: [] }],
        },
      }),
      expect.objectContaining({
        edge: { id: "red:green", source: "red", target: "green" },
        sequence: 2,
        type: "workflow.edge",
      }),
    ]);
    expect(
      singleRecord({ attempt: 1, nodeId: "red", type: "node.start" })
    ).toMatchObject({ node: { nodeId: "red", status: "running" } });
    expect(
      singleRecord({
        gateId: "RED",
        kind: "command",
        nodeId: "red",
        passed: true,
        type: "gate.finish",
      })
    ).toMatchObject({
      gate: { gateId: "RED", passed: true, status: "passed" },
    });
    expect(
      singleRecord({
        nodeId: "red",
        passed: true,
        path: "tests/runner-event-sink.test.ts",
        required: true,
        type: "artifact.check.finish",
      })
    ).toMatchObject({
      artifact: {
        path: "tests/runner-event-sink.test.ts",
        passed: true,
        uri: "tests/runner-event-sink.test.ts",
      },
    });
    expect(
      singleRecord({
        attempt: 1,
        format: "text",
        nodeId: "red",
        output: "targeted failing tests",
        type: "node.output.recorded",
      })
    ).toMatchObject({
      log: {
        message: "targeted failing tests",
        nodeId: "red",
        output: "targeted failing tests",
      },
    });
    expect(
      singleRecord({
        outcome: "FAIL",
        type: "workflow.finish",
        workflowId: "default",
      })
    ).toMatchObject({ finalResult: { outcome: "FAIL" } });
    expect(
      singleRecord({
        outcome: "CANCELLED",
        type: "workflow.finish",
        workflowId: "default",
      })
    ).toMatchObject({ finalResult: { outcome: "CANCELLED" } });
  });

  it("records cancellation before the final flush", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(async () => okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
      now: () => new Date(TIMESTAMP),
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordCancellation("default");
    await sink.flush();

    expect(parseBodies(fetchMock)).toEqual([
      {
        events: [
          {
            at: TIMESTAMP,
            log: {
              level: "warn",
              message:
                "Runner received a termination signal and cancelled the run.",
            },
            sequence: 1,
            type: "run.cancelled",
          },
          {
            at: TIMESTAMP,
            finalResult: {
              outcome: "CANCELLED",
              workflowId: "default",
            },
            sequence: 2,
            type: "workflow.finish",
          },
        ],
      },
    ]);
  });

  it("flushes a runtime CANCELLED final result and preserves it after a failed flush", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("console unavailable"))
      .mockResolvedValueOnce(okResponse());
    const sink = createRunnerEventSink({
      fetch: fetchMock,
      authToken: "console-token",
      retryDelayMs: 0,
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordRuntimeEvent({
      outcome: "CANCELLED",
      type: "workflow.finish",
      workflowId: "default",
    });

    await expect(sink.flush()).rejects.toThrow(CONSOLE_UNAVAILABLE_RE);
    await sink.flush();

    expect(parseBodies(fetchMock)[1]).toEqual({
      events: [
        {
          finalResult: {
            outcome: "CANCELLED",
            workflowId: "default",
          },
          at: expect.any(String),
          sequence: 1,
          type: "workflow.finish",
        },
      ],
    });
  });
});
