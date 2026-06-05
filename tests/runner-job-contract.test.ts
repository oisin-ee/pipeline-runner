import { describe, expect, it } from "vitest";

const RUNNER_PAYLOAD_ENV = "OISIN_PIPELINE_RUNNER_PAYLOAD_JSON";
const TIMESTAMP = "2026-06-02T09:00:00.000Z";
const RUNNER_JOB_CONTRACT_VERSION = "1";
const EVENT_URL = "https://console.example.test/api/pipeline/runner-events";
const MISSING_RUN_ID_RE = /run\.id.*required/i;
const INVALID_REPOSITORY_URL_RE = /repository\.url.*valid URL/i;
const AUTH_TOKEN_ENV_RE = /PIPELINE_EVENT_API_TOKEN/i;
const PROTOTYPE_POLLUTION_RE = /proto/i;
const CONTRACT_VERSION_RE = /contract version/i;

function validPayload(): Record<string, unknown> {
  return {
    contractVersion: RUNNER_JOB_CONTRACT_VERSION,
    delivery: { pullRequest: false },
    events: {
      authHeader: "Authorization",
      authTokenEnv: "PIPELINE_EVENT_API_TOKEN",
      url: EVENT_URL,
    },
    repository: {
      baseBranch: "main",
      sha: "0123456789abcdef0123456789abcdef01234567",
      url: "https://github.com/oisin-ee/pipeline-runner.git",
    },
    run: {
      id: "run_123",
      project: "project_123",
      requestedBy: "user_456",
    },
    task: {
      kind: "prompt",
      prompt: "Ship PIPE-38",
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
      project: "project_123",
      events: validPayload().events,
      repository: validPayload().repository,
      requestedBy: "user_456",
      runId: "run_123",
      taskPrompt: "Ship PIPE-38",
    });

    expect(env).toEqual({
      name: RUNNER_PAYLOAD_ENV,
      value: JSON.stringify(validPayload()),
    });
  });

  it("builds the public console-to-runner payload contract with hook policy defaults", async () => {
    const { buildRunnerJobPayload } = await loadContractModule();

    const payload = buildRunnerJobPayload({
      repository: validPayload().repository,
      events: validPayload().events,
      run: {
        id: "run_123",
        project: "project_123",
        requestedBy: "user_456",
      },
      task: {
        kind: "prompt",
        prompt: "Ship PIPE-38",
      },
    });

    expect(payload).toEqual(validPayload());
  });

  it("parses a ticket task payload", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      task: {
        id: "PIPE-49.10",
        kind: "ticket",
        path: "backlog/tasks/pipe-49.10.md",
      },
    };

    const parsed = parseRunnerJobPayload(JSON.stringify(payload));

    expect(parsed.task).toEqual(payload.task);
  });

  it("parses a valid runner payload without adding console-only fields", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();

    const parsed = parseRunnerJobPayload(JSON.stringify(validPayload()));

    expect(parsed).toEqual(validPayload());
    expect(Object.keys(parsed).sort()).toEqual([
      "contractVersion",
      "delivery",
      "events",
      "repository",
      "run",
      "task",
    ]);
  });

  it("exports schemas and types for each payload component", async () => {
    const contract = await loadContractModule();

    expect(contract.RUNNER_JOB_CONTRACT_VERSION).toBe(
      RUNNER_JOB_CONTRACT_VERSION
    );
    expect(contract.runnerJobPayloadJsonSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        contractVersion: { type: "string" },
        repository: {
          additionalProperties: false,
          properties: {
            baseBranch: { type: "string" },
            url: { type: "string" },
          },
        },
        events: {
          additionalProperties: false,
          properties: {
            authHeader: { type: "string" },
            authTokenEnv: { type: "string" },
            url: { type: "string" },
          },
        },
      },
      type: "object",
    });
    expect(contract.runnerRunIdentitySchema.parse(validPayload().run)).toEqual(
      validPayload().run
    );
    expect(contract.runnerTaskSchema.parse(validPayload().task)).toEqual(
      validPayload().task
    );
    expect(contract.runnerEventsSchema.parse(validPayload().events)).toEqual(
      validPayload().events
    );
  });

  it("rejects payloads missing required runner fields", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = validPayload();
    (payload.run as Record<string, unknown>).id = undefined;

    expect(() => parseRunnerJobPayload(JSON.stringify(payload))).toThrow(
      MISSING_RUN_ID_RE
    );
  });

  it("rejects incompatible runner contract versions with structured issue details", async () => {
    const { parseRunnerJobPayloadWithIssues } = await loadContractModule();
    const payload = {
      ...validPayload(),
      contractVersion: "2",
    };

    const parsed = parseRunnerJobPayloadWithIssues(JSON.stringify(payload));

    expect(parsed).toEqual({
      ok: false,
      error: expect.objectContaining({
        issues: [
          expect.objectContaining({
            message: expect.stringMatching(CONTRACT_VERSION_RE),
            path: "contractVersion",
          }),
        ],
      }),
      recoverable: { events: validPayload().events, run: validPayload().run },
    });
  });

  it("rejects prototype-polluting runner payload JSON", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = `{"__proto__":{"polluted":true},"repository":{"baseBranch":"main","url":"https://github.com/oisin-ee/pipeline-runner.git"},"run":{"id":"run_123","project":"project_123","requestedBy":"user_456"},"task":{"kind":"prompt","prompt":"Ship PIPE-38"}}`;

    expect(() => parseRunnerJobPayload(payload)).toThrow(
      PROTOTYPE_POLLUTION_RE
    );
  });

  it("rejects invalid repository URLs before the runner starts", async () => {
    const { parseRunnerJobPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      repository: {
        baseBranch: "main",
        url: "not a url",
      },
    };

    expect(() => parseRunnerJobPayload(JSON.stringify(payload))).toThrow(
      INVALID_REPOSITORY_URL_RE
    );
  });

  it("fails fast when the configured console event token cannot be resolved", async () => {
    const { resolveRunnerEventSinkAuthToken } = await loadContractModule();

    expect(() =>
      resolveRunnerEventSinkAuthToken({
        authTokenEnv: "PIPELINE_EVENT_API_TOKEN",
        env: {},
      })
    ).toThrow(AUTH_TOKEN_ENV_RE);
  });

  it("resolves the bearer token using the configured env name", async () => {
    const {
      resolveRunnerEventSinkAuthHeader,
      resolveRunnerEventSinkAuthToken,
    } = await loadContractModule();

    expect(
      resolveRunnerEventSinkAuthToken({
        authTokenEnv: "PIPELINE_EVENT_API_TOKEN",
        env: {
          PIPELINE_EVENT_API_TOKEN: "fallback-token",
        },
      })
    ).toBe("fallback-token");
    expect(
      resolveRunnerEventSinkAuthHeader({
        authTokenEnv: "PIPELINE_EVENT_API_TOKEN",
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

  it("maps hook result events into console hook result records", async () => {
    const { mapRuntimeEventToRunnerEventRecords } = await loadContractModule();

    const mapped = mapRuntimeEventToRunnerEventRecords(
      {
        event: "node.finish",
        functionId: "publish-console-summary",
        hookId: "publish-verify-summary",
        nodeId: "verify",
        outputs: {
          messageId: "msg_123",
          url: "https://console.example.test/runs/run_123",
        },
        status: "pass",
        summary: "Verification summary published",
        type: "hook.result",
        workflowId: "default",
      },
      { runId: "run_123", sequence: 9, timestamp: TIMESTAMP }
    );

    expect(mapped).toEqual([
      {
        at: TIMESTAMP,
        hookResult: {
          event: "node.finish",
          functionId: "publish-console-summary",
          hookId: "publish-verify-summary",
          nodeId: "verify",
          outputs: {
            messageId: "msg_123",
            url: "https://console.example.test/runs/run_123",
          },
          status: "pass",
          summary: "Verification summary published",
          workflowId: "default",
        },
        sequence: 9,
        type: "hook.result",
      },
    ]);
  });
});
