import { describe, expect, it, vi } from "vitest";

const EVENT_SINK_URL = "https://console.example.test/api/runs/run_123/events";
const TIMESTAMP = "2026-06-02T09:00:00.000Z";
const CONSOLE_UNAVAILABLE_RE = /console unavailable/iu;
const EVENT_SINK_400_RE = /event sink responded with 400: status 400/iu;
const EVENT_SINK_503_RE = /event sink.*503/iu;
const REQUEST_TIMED_OUT_RE = /timed out/iu;

const okResponse = (): Response => new Response("", { status: 200 });

const responseWithStatus = (status: number): Response => new Response(`status ${status}`, { status });

const hasEventSequences = (value: unknown): value is { events: { sequence: number }[] } =>
  typeof value === "object" &&
  value !== null &&
  "events" in value &&
  Array.isArray(value.events) &&
  value.events.every(
    (event) => typeof event === "object" && event !== null && "sequence" in event && typeof event.sequence === "number",
  );

const parseEventSequencesBody = (body: string): { sequence: number }[] => {
  const parsed: unknown = JSON.parse(body);
  if (!hasEventSequences(parsed)) {
    throw new Error("expected runner event batch body");
  }
  return parsed.events;
};

const loadSinkModule = async (): Promise<Record<string, any>> => await import("../src/runner-event-sink");

const loadContractModule = async (): Promise<Record<string, any>> => await import("../src/runner-command-contract");

const requestFromCall = (call: unknown[]): Request => {
  const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
  return new Request(input, init);
};

const parseBodies = async (fetchMock: ReturnType<typeof vi.fn>): Promise<any[]> => {
  const bodies: any[] = [];
  for (const call of fetchMock.mock.calls) {
    bodies.push(JSON.parse(await requestFromCall(call).text()));
  }
  return bodies;
};

describe("runner event sink", () => {
  it("uses injected fetch, assigns integer sequences from 1, batches, adds auth, and supplies timestamps", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(() => okResponse());
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
      profile: "moka-test-writer",
      runnerId: "opencode",
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
    const firstRequest = requestFromCall(fetchMock.mock.calls[0]);
    expect(firstRequest.url).toBe(EVENT_SINK_URL);
    expect(firstRequest.method).toBe("POST");
    expect(firstRequest.headers.get("Authorization")).toBe("Bearer console-token");
    expect(firstRequest.headers.get("Content-Type")).toContain("application/json");
    expect(await parseBodies(fetchMock)).toEqual([
      {
        events: [
          {
            at: TIMESTAMP,
            node: {
              attempt: 1,
              nodeId: "red",
              profile: "moka-test-writer",
              runnerId: "opencode",
              status: "running",
            },
            runId: "run_123",
            sequence: 1,
            type: "node.start",
          },
          {
            at: TIMESTAMP,
            gate: {
              evidence: ["failed as expected"],
              gateId: "RED",
              kind: "command",
              label: "RED",
              nodeId: "red",
              passed: false,
              status: "failed",
            },
            runId: "run_123",
            sequence: 2,
            type: "gate.finish",
          },
        ],
      },
      {
        events: [
          {
            at: TIMESTAMP,
            finalResult: {
              outcome: "PASS",
              workflowId: "default",
            },
            runId: "run_123",
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
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
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

  it.each([408, 429, 500, 503, 511])("retries retryable HTTP %i responses", async (status) => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn().mockResolvedValueOnce(responseWithStatus(status)).mockResolvedValueOnce(okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
      maxRetries: 1,
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

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not retry permanent 400 responses", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(() => responseWithStatus(400));
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

    await expect(sink.flush()).rejects.toThrow(EVENT_SINK_400_RE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries request timeouts", async () => {
    vi.useFakeTimers();
    try {
      const { createRunnerEventSink } = await loadSinkModule();
      const fetchMock = vi.fn(async () => await new Promise<Response>(() => {}));
      const sink = createRunnerEventSink({
        authToken: "console-token",
        fetch: fetchMock,
        maxRetries: 1,
        retryDelayMs: 0,
        runId: "run_123",
        url: EVENT_SINK_URL,
      });

      sink.recordRuntimeEvent({
        outcome: "PASS",
        type: "workflow.finish",
        workflowId: "default",
      });

      const flush = expect(sink.flush()).rejects.toThrow(REQUEST_TIMED_OUT_RE);
      await vi.advanceTimersByTimeAsync(20_000);

      await flush;
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([401, 403])("treats %i as a terminal event sink authorization failure", async (status) => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(() => responseWithStatus(status));
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

    await expect(sink.flush()).rejects.toThrow(new RegExp(`event sink.*${status}: status ${status}`, "iu"));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const bodies = await parseBodies(fetchMock);
    expect(bodies.at(-1)?.events).toEqual([
      expect.objectContaining({
        finalResult: { outcome: "PASS", workflowId: "default" },
        type: "workflow.finish",
      }),
    ]);
  });

  it("flushes batches in the same order events were recorded", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(() => okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      batchSize: 2,
      fetch: fetchMock,
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
      (await parseBodies(fetchMock)).flatMap((body) =>
        body.events.map((event: { sequence: number }) => event.sequence),
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(
      (await parseBodies(fetchMock)).flatMap((body) =>
        body.events.map((event: { node: { nodeId: string } }) => event.node.nodeId),
      ),
    ).toEqual(["red", "green", "verify", "review"]);
  });

  it("keeps a failed mid-run batch queued and delivers later records after it", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const deliveredBatches: { sequence: number }[][] = [];
    let requestCount = 0;
    const fetchMock = vi.fn(async (input, init) => {
      requestCount += 1;
      const request = new Request(input, init);
      const events = parseEventSequencesBody(await request.text());
      if (requestCount === 1) {
        return responseWithStatus(503);
      }
      deliveredBatches.push(events);
      return okResponse();
    });
    const sink = createRunnerEventSink({
      authToken: "console-token",
      batchSize: 2,
      fetch: fetchMock,
      maxRetries: 0,
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

    await expect(sink.flush()).rejects.toThrow(EVENT_SINK_503_RE);
    sink.recordRuntimeEvent({
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "default",
    });
    await sink.flush();

    expect(deliveredBatches).toHaveLength(3);
    expect(deliveredBatches.flatMap((batch) => batch.map((event) => event.sequence))).toEqual([1, 2, 3, 4, 5]);
  });

  it("flushes runtime events without waiting for an explicit final flush", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(() => okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
      now: () => new Date(TIMESTAMP),
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordRuntimeEvent({
      edges: [{ source: "plan", target: "execute" }],
      nodes: [
        { id: "plan", kind: "agent", needs: [] },
        { id: "execute", kind: "agent", needs: ["plan"] },
      ],
      type: "workflow.planned",
      workflowId: "default",
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (fetchMock.mock.calls.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(await parseBodies(fetchMock)).toEqual([
      {
        events: [
          {
            at: TIMESTAMP,
            runId: "run_123",
            sequence: 1,
            type: "workflow.planned",
            workflowPlan: {
              edges: [{ source: "plan", target: "execute" }],
              nodes: [
                { id: "plan", kind: "agent", needs: [] },
                { id: "execute", kind: "agent", needs: ["plan"] },
              ],
              workflowId: "default",
            },
          },
          {
            at: TIMESTAMP,
            edge: {
              id: "plan:execute",
              source: "plan",
              target: "execute",
            },
            runId: "run_123",
            sequence: 2,
            type: "workflow.edge",
          },
        ],
      },
    ]);

    await sink.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
        { runId: "run_123", sequence: 1, timestamp: TIMESTAMP },
      ),
    ).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "workflow.planned",
        workflowPlan: {
          edges: [{ source: "red", target: "green" }],
          nodes: [{ id: "red", kind: "agent", needs: [] }],
          workflowId: "default",
        },
      }),
      expect.objectContaining({
        edge: { id: "red:green", source: "red", target: "green" },
        sequence: 2,
        type: "workflow.edge",
      }),
    ]);
    expect(singleRecord({ attempt: 1, nodeId: "red", type: "node.start" })).toMatchObject({
      node: { nodeId: "red", status: "running" },
    });
    expect(
      singleRecord({
        gateId: "RED",
        kind: "command",
        nodeId: "red",
        passed: true,
        type: "gate.finish",
      }),
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
      }),
    ).toMatchObject({
      artifact: {
        passed: true,
        path: "tests/runner-event-sink.test.ts",
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
      }),
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
      }),
    ).toMatchObject({ finalResult: { outcome: "FAIL" } });
    expect(
      singleRecord({
        outcome: "CANCELLED",
        type: "workflow.finish",
        workflowId: "default",
      }),
    ).toMatchObject({ finalResult: { outcome: "CANCELLED" } });
  });

  it("maps node.session to no wire records instead of throwing", async () => {
    const { mapRuntimeEventToRunnerEventRecords } = await loadContractModule();
    // node.session is an in-process run-control/projection event with no
    // representation in the runner -> event-sink wire contract. It must map to
    // an empty record set rather than hit the unhandled-event guard, which
    // previously crashed task.run on the cluster.
    expect(
      mapRuntimeEventToRunnerEventRecords(
        {
          nodeId: "backlog-intake",
          sessionId: "ses_abc",
          type: "node.session",
        },
        { runId: "run_123", sequence: 1, timestamp: TIMESTAMP },
      ),
    ).toEqual([]);
  });

  it("records cancellation before the final flush", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(() => okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
      now: () => new Date(TIMESTAMP),
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordCancellation("default");
    await sink.flush();

    expect(await parseBodies(fetchMock)).toEqual([
      {
        events: [
          {
            at: TIMESTAMP,
            log: {
              level: "warn",
              message: "Runner received a termination signal and cancelled the run.",
            },
            runId: "run_123",
            sequence: 1,
            type: "run.cancelled",
          },
          {
            at: TIMESTAMP,
            finalResult: {
              outcome: "CANCELLED",
              workflowId: "default",
            },
            runId: "run_123",
            sequence: 2,
            type: "workflow.finish",
          },
        ],
      },
    ]);
  });

  it("serializes runtime observability events without raw inspection payloads", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi.fn(() => okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
      now: () => new Date(TIMESTAMP),
      runId: "run_123",
      url: EVENT_SINK_URL,
    });

    sink.recordRuntimeEvent({
      actor: {
        id: "pipeline.node.run-123.default.red",
        kind: "node",
        systemId: "pipeline.run-123",
      },
      level: "info",
      name: "runtime.actor.snapshot",
      nodeId: "red",
      summary: "node actor pipeline.node.run-123.default.red snapshot recorded",
      type: "runtime.observability",
      workflowId: "default",
    });

    await sink.flush();

    const bodies = await parseBodies(fetchMock);
    expect(bodies).toEqual([
      {
        events: [
          {
            at: TIMESTAMP,
            log: {
              level: "info",
              message:
                "Runtime observed: runtime.actor.snapshot - node actor pipeline.node.run-123.default.red snapshot recorded",
              nodeId: "red",
              workflowId: "default",
            },
            runId: "run_123",
            sequence: 1,
            type: "runtime.observability",
          },
        ],
      },
    ]);
    expect(JSON.stringify(bodies)).not.toContain("secret-token");
    expect(JSON.stringify(bodies)).not.toContain('snapshot":{"');
  });

  it("flushes a runtime CANCELLED final result and preserves it after a failed flush", async () => {
    const { createRunnerEventSink } = await loadSinkModule();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("console unavailable"))
      .mockResolvedValueOnce(okResponse());
    const sink = createRunnerEventSink({
      authToken: "console-token",
      fetch: fetchMock,
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

    expect((await parseBodies(fetchMock))[1]).toEqual({
      events: [
        {
          at: expect.any(String),
          finalResult: {
            outcome: "CANCELLED",
            workflowId: "default",
          },
          runId: "run_123",
          sequence: 1,
          type: "workflow.finish",
        },
      ],
    });
  });
});
