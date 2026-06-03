import { describe, expect, it } from "vitest";

const RUNNER_PAYLOAD_ENV = "OISIN_PIPELINE_RUNNER_PAYLOAD_JSON";
const EVENT_SINK_URL = "https://console.example.test/api/runs/run_123/events";
const TIMESTAMP = "2026-06-02T09:00:00.000Z";
const MISSING_RUN_ID_RE = /run\.runId.*required/i;
const UNSUPPORTED_SELECTOR_RE =
  /unsupported selector.*entrypoint|selector\.workflowId/i;
const INVALID_EVENT_SINK_URL_RE = /eventSink\.url.*valid URL/i;
const AUTH_TOKEN_ENV_RE =
  /OISIN_PIPELINE_EVENT_AUTH_TOKEN|PIPELINE_EVENT_API_TOKEN/i;
const PROTOTYPE_POLLUTION_RE = /proto/i;

function validPayload(): Record<string, unknown> {
  return {
    eventSink: {
      authHeader: "Authorization",
      url: EVENT_SINK_URL,
    },
    run: {
      projectId: "project_123",
      requestedBy: "user_456",
      runId: "run_123",
    },
    selector: {
      workflowId: "default",
    },
    task: {
      prompt: "Ship PIPE-38",
      taskId: "PIPE-38",
    },
  };
}

function loadContractModule(): Promise<Record<string, any>> {
  return import("../src/runner-job-contract.js");
}

describe("runner-job payload contract", () => {
  it("serializes the exact console payload env var shape", async () => {
    const { createRunnerJobPayloadEnv } = await loadContractModule();

    const env = createRunnerJobPayloadEnv({
      eventSinkUrl: EVENT_SINK_URL,
      projectId: "project_123",
      requestedBy: "user_456",
      runId: "run_123",
      taskId: "PIPE-38",
      taskPrompt: "Ship PIPE-38",
      workflowId: "default",
    });

    expect(env).toEqual({
      name: RUNNER_PAYLOAD_ENV,
      value: JSON.stringify(validPayload()),
    });
  });

  it("parses a valid runner payload without adding console-only fields", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();

    const parsed = parseRunnerJobPayload(JSON.stringify(validPayload()));

    expect(parsed).toEqual(validPayload());
    expect(Object.keys(parsed).sort()).toEqual([
      "eventSink",
      "run",
      "selector",
      "task",
    ]);
  });

  it("exports schemas and types for each payload component", async () => {
    const contract = await loadContractModule();

    expect(
      contract.runnerEventSinkConfigSchema.parse(validPayload().eventSink)
    ).toEqual(validPayload().eventSink);
    expect(contract.runnerRunIdentitySchema.parse(validPayload().run)).toEqual(
      validPayload().run
    );
    expect(
      contract.runnerWorkflowSelectorSchema.parse(validPayload().selector)
    ).toEqual(validPayload().selector);
    expect(contract.runnerTaskPromptSchema.parse(validPayload().task)).toEqual(
      validPayload().task
    );
  });

  it("rejects payloads missing required runner fields", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = validPayload();
    (payload.run as Record<string, unknown>).runId = undefined;

    expect(() => parseRunnerJobPayload(JSON.stringify(payload))).toThrow(
      MISSING_RUN_ID_RE
    );
  });

  it("rejects unsupported selectors instead of guessing the workflow", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      selector: { entrypoint: "quick" },
    };

    expect(() => parseRunnerJobPayload(JSON.stringify(payload))).toThrow(
      UNSUPPORTED_SELECTOR_RE
    );
  });

  it("rejects prototype-polluting runner payload JSON", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = `{"__proto__":{"polluted":true},"eventSink":{"authHeader":"Authorization","url":"${EVENT_SINK_URL}"},"run":{"projectId":"project_123","requestedBy":"user_456","runId":"run_123"},"selector":{"workflowId":"default"},"task":{"prompt":"Ship PIPE-38","taskId":"PIPE-38"}}`;

    expect(() => parseRunnerJobPayload(payload)).toThrow(
      PROTOTYPE_POLLUTION_RE
    );
  });

  it("rejects invalid event sink URLs before the runner starts", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      eventSink: {
        authHeader: "Authorization",
        url: "not a url",
      },
    };

    expect(() => parseRunnerJobPayload(JSON.stringify(payload))).toThrow(
      INVALID_EVENT_SINK_URL_RE
    );
  });

  it("fails fast when the console event token cannot be resolved", async () => {
    const { resolveRunnerEventSinkAuthToken } = await loadContractModule();

    expect(() =>
      resolveRunnerEventSinkAuthToken({
        env: {},
        serviceAccountTokenPath: "/tmp/does-not-exist-pipe-38-token",
      })
    ).toThrow(AUTH_TOKEN_ENV_RE);
  });

  it("resolves the bearer token using the runner-side lookup order", async () => {
    const {
      resolveRunnerEventSinkAuthHeader,
      resolveRunnerEventSinkAuthToken,
    } = await loadContractModule();

    expect(
      resolveRunnerEventSinkAuthToken({
        env: {
          OISIN_PIPELINE_EVENT_AUTH_TOKEN: "primary-token",
          PIPELINE_EVENT_API_TOKEN: "fallback-token",
        },
      })
    ).toBe("primary-token");
    expect(
      resolveRunnerEventSinkAuthHeader({
        env: { PIPELINE_EVENT_API_TOKEN: "fallback-token" },
      })
    ).toBe("Bearer fallback-token");
  });

  it("maps runtime events into the RunnerEventRecord fields accepted by console", async () => {
    const { mapRuntimeEventToRunnerEventRecords } = await loadContractModule();

    const mapped = [
      ...mapRuntimeEventToRunnerEventRecords(
        {
          edges: [{ source: "red", target: "green" }],
          nodes: [
            {
              id: "red",
              kind: "agent",
              needs: [],
              profile: "pipeline-test-writer",
              runnerId: "codex",
            },
          ],
          type: "workflow.planned",
          workflowId: "default",
        },
        { runId: "run_123", sequence: 1, timestamp: TIMESTAMP }
      ),
      ...mapRuntimeEventToRunnerEventRecords(
        {
          attempt: 1,
          nodeId: "red",
          profile: "pipeline-test-writer",
          runnerId: "codex",
          type: "node.start",
        },
        { runId: "run_123", sequence: 3, timestamp: TIMESTAMP }
      ),
      ...mapRuntimeEventToRunnerEventRecords(
        {
          evidence: ["RED failed as expected"],
          gateId: "RED",
          kind: "command",
          nodeId: "red",
          passed: false,
          reason: "targeted tests failed",
          type: "gate.finish",
        },
        { runId: "run_123", sequence: 4, timestamp: TIMESTAMP }
      ),
      ...mapRuntimeEventToRunnerEventRecords(
        {
          nodeId: "red",
          passed: true,
          path: "tests/runner-job-contract.test.ts",
          required: true,
          type: "artifact.check.finish",
        },
        { runId: "run_123", sequence: 5, timestamp: TIMESTAMP }
      ),
      ...mapRuntimeEventToRunnerEventRecords(
        {
          attempt: 1,
          format: "text",
          nodeId: "red",
          output: "failing-test evidence",
          type: "node.output.recorded",
        },
        { runId: "run_123", sequence: 6, timestamp: TIMESTAMP }
      ),
      ...mapRuntimeEventToRunnerEventRecords(
        {
          outcome: "PASS",
          type: "workflow.finish",
          workflowId: "default",
        },
        { runId: "run_123", sequence: 7, timestamp: TIMESTAMP }
      ),
    ];

    expect(mapped).toEqual([
      {
        at: TIMESTAMP,
        sequence: 1,
        type: "workflow.planned",
        workflowPlan: {
          edges: [{ source: "red", target: "green" }],
          nodes: [
            {
              id: "red",
              kind: "agent",
              needs: [],
              profile: "pipeline-test-writer",
              runnerId: "codex",
            },
          ],
          workflowId: "default",
        },
      },
      {
        at: TIMESTAMP,
        edge: {
          id: "red:green",
          source: "red",
          target: "green",
        },
        sequence: 2,
        type: "workflow.edge",
      },
      {
        node: {
          attempt: 1,
          nodeId: "red",
          profile: "pipeline-test-writer",
          runnerId: "codex",
          status: "running",
        },
        at: TIMESTAMP,
        sequence: 3,
        type: "node.start",
      },
      {
        gate: {
          evidence: ["RED failed as expected"],
          gateId: "RED",
          kind: "command",
          label: "RED",
          nodeId: "red",
          passed: false,
          reason: "targeted tests failed",
          status: "failed",
        },
        at: TIMESTAMP,
        sequence: 4,
        type: "gate.finish",
      },
      {
        artifact: {
          kind: "artifact",
          label: "tests/runner-job-contract.test.ts",
          nodeId: "red",
          passed: true,
          path: "tests/runner-job-contract.test.ts",
          required: true,
          status: "passed",
          uri: "tests/runner-job-contract.test.ts",
        },
        at: TIMESTAMP,
        sequence: 5,
        type: "artifact.check.finish",
      },
      {
        log: {
          format: "text",
          level: "info",
          message: "failing-test evidence",
          nodeId: "red",
          output: "failing-test evidence",
        },
        at: TIMESTAMP,
        sequence: 6,
        type: "node.output.recorded",
      },
      {
        finalResult: {
          outcome: "PASS",
          workflowId: "default",
        },
        at: TIMESTAMP,
        sequence: 7,
        type: "workflow.finish",
      },
    ]);
  });

  it("maps runtime observability events into stable runner logs", async () => {
    const { mapRuntimeEventToRunnerEventRecords } = await loadContractModule();

    const mapped = mapRuntimeEventToRunnerEventRecords(
      {
        actor: {
          id: "pipeline.node.run-123.default.red",
          kind: "node",
          systemId: "pipeline.run-123",
        },
        level: "warn",
        name: "runtime.retry.exhausted",
        nodeId: "red",
        summary: "node red retry exhausted after attempt 3 (exit_nonzero)",
        type: "runtime.observability",
        workflowId: "default",
      },
      { runId: "run_123", sequence: 8, timestamp: TIMESTAMP }
    );

    expect(mapped).toEqual([
      {
        at: TIMESTAMP,
        log: {
          level: "warn",
          message:
            "Runtime observed: runtime.retry.exhausted - node red retry exhausted after attempt 3 (exit_nonzero)",
          nodeId: "red",
          workflowId: "default",
        },
        sequence: 8,
        type: "runtime.observability",
      },
    ]);
  });
});
