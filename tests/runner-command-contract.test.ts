import { describe, expect, it } from "vitest";

const TIMESTAMP = "2026-06-02T09:00:00.000Z";
const RUNNER_COMMAND_CONTRACT_VERSION = "1";
const EVENT_URL = "https://console.example.test/api/pipeline/runner-events";
const MISSING_RUN_ID_RE = /run\.id.*required/i;
const INVALID_REPOSITORY_URL_RE = /repository\.url.*valid URL/i;
const PROTOTYPE_POLLUTION_RE = /proto/i;
const CONTRACT_VERSION_RE = /contract version/i;
const AUTH_TOKEN_FILE_RE = /authTokenFile/i;
const INVALID_SUBMISSION_MODE_RE = /submission\.mode/i;

function validEvents(): Record<string, unknown> {
  return {
    authHeader: "Authorization",
    authTokenFile: "/etc/pipeline/event-auth/token",
    url: EVENT_URL,
  };
}

function validPayload(): Record<string, unknown> {
  return {
    contractVersion: RUNNER_COMMAND_CONTRACT_VERSION,
    delivery: { pullRequest: false },
    events: validEvents(),
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
    submission: {
      kind: "graph",
      mode: "full",
    },
    workflow: {
      id: "schedule-run-123-root",
    },
  };
}

function loadContractModule(): Promise<Record<string, any>> {
  return import("../src/runner-command-contract");
}

describe("runner-command payload contract", () => {
  it("builds the public console-to-runner payload contract with hook policy defaults", async () => {
    const { buildRunnerCommandPayload } = await loadContractModule();

    const payload = buildRunnerCommandPayload({
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
      workflow: {
        id: "schedule-run-123-root",
      },
    });

    expect(payload).toEqual(validPayload());
  });

  it("parses a ticket task payload", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      task: {
        id: "PIPE-49.10",
        kind: "ticket",
        path: "backlog/tasks/pipe-49.10.md",
      },
    };

    const parsed = parseRunnerCommandPayload(JSON.stringify(payload));

    expect(parsed.task).toEqual(payload.task);
  });

  it("parses a valid runner payload without adding console-only fields", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();

    const parsed = parseRunnerCommandPayload(JSON.stringify(validPayload()));

    expect(parsed).toEqual(validPayload());
    expect(Object.keys(parsed).sort()).toEqual([
      "contractVersion",
      "delivery",
      "events",
      "repository",
      "run",
      "submission",
      "task",
      "workflow",
    ]);
  });

  it("accepts quick as a valid graph submission mode", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      submission: {
        kind: "graph",
        mode: "quick",
      },
    };

    const parsed = parseRunnerCommandPayload(JSON.stringify(payload));

    expect(parsed.submission).toEqual({ kind: "graph", mode: "quick" });
  });

  it("accepts explicit argv as a valid command submission", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      submission: {
        argv: ["opencode", "run", "fix this bug"],
        kind: "command",
      },
    };

    const parsed = parseRunnerCommandPayload(JSON.stringify(payload));

    expect(parsed.submission).toEqual({
      argv: ["opencode", "run", "fix this bug"],
      kind: "command",
    });
  });

  it("rejects invalid graph submission modes", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      submission: {
        kind: "graph",
        mode: "execute",
      },
    };

    expect(() => parseRunnerCommandPayload(JSON.stringify(payload))).toThrow(
      INVALID_SUBMISSION_MODE_RE
    );
  });

  it("accepts SSH git remotes as repository URLs", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      repository: {
        baseBranch: "main",
        sha: "0123456789abcdef0123456789abcdef01234567",
        url: "git@github.com:oisin-ee/pipeline-runner.git",
      },
    };

    const parsed = parseRunnerCommandPayload(JSON.stringify(payload));

    expect(parsed.repository.url).toBe(
      "git@github.com:oisin-ee/pipeline-runner.git"
    );
  });

  it("exports schemas and types for each payload component", async () => {
    const contract = await loadContractModule();

    expect(contract.runnerCommandPayloadSchema.parse(validPayload())).toEqual(
      validPayload()
    );
    expect(
      contract.parseRunnerCommandPayload(JSON.stringify(validPayload()))
    ).toEqual(validPayload());
  });

  it("rejects payloads missing required runner fields", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = validPayload();
    (payload.run as Record<string, unknown>).id = undefined;

    expect(() => parseRunnerCommandPayload(JSON.stringify(payload))).toThrow(
      MISSING_RUN_ID_RE
    );
  });

  it("rejects incompatible runner contract versions with structured issue details", async () => {
    const { RunnerCommandPayloadValidationError, parseRunnerCommandPayload } =
      await loadContractModule();
    const payload = {
      ...validPayload(),
      contractVersion: "2",
    };

    expect(() => parseRunnerCommandPayload(JSON.stringify(payload))).toThrow(
      RunnerCommandPayloadValidationError
    );
    try {
      parseRunnerCommandPayload(JSON.stringify(payload));
    } catch (error) {
      expect(error).toMatchObject({
        issues: [
          expect.objectContaining({
            message: expect.stringMatching(CONTRACT_VERSION_RE),
            path: "contractVersion",
          }),
        ],
      });
    }
  });

  it("rejects prototype-polluting runner payload JSON", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = `{"__proto__":{"polluted":true},"repository":{"baseBranch":"main","url":"https://github.com/oisin-ee/pipeline-runner.git"},"run":{"id":"run_123","project":"project_123","requestedBy":"user_456"},"task":{"kind":"prompt","prompt":"Ship PIPE-38"}}`;

    expect(() => parseRunnerCommandPayload(payload)).toThrow(
      PROTOTYPE_POLLUTION_RE
    );
  });

  it("rejects invalid repository URLs before the runner starts", async () => {
    const { parseRunnerCommandPayload } = await loadContractModule();
    const payload = {
      ...validPayload(),
      repository: {
        baseBranch: "main",
        url: "not a url",
      },
    };

    expect(() => parseRunnerCommandPayload(JSON.stringify(payload))).toThrow(
      INVALID_REPOSITORY_URL_RE
    );
  });

  it("fails fast when the configured console event token file is missing", async () => {
    const { resolveRunnerEventSinkAuthToken } = await loadContractModule();

    expect(() => resolveRunnerEventSinkAuthToken({})).toThrow(
      AUTH_TOKEN_FILE_RE
    );
  });

  it("resolves the bearer token using the configured authTokenFile", async () => {
    const { resolveRunnerEventSinkAuthToken } = await loadContractModule();

    expect(
      resolveRunnerEventSinkAuthToken({
        authTokenFile: "/etc/pipeline/event-auth/token",
        readFile: () => "file-based-token",
      })
    ).toBe("file-based-token");
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
              runnerId: "opencode",
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
          runnerId: "opencode",
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
          path: "tests/runner-command-contract.test.ts",
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
              runnerId: "opencode",
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
          runnerId: "opencode",
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
          label: "tests/runner-command-contract.test.ts",
          nodeId: "red",
          passed: true,
          path: "tests/runner-command-contract.test.ts",
          required: true,
          status: "passed",
          uri: "tests/runner-command-contract.test.ts",
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

  describe("authTokenFile support", () => {
    /**
     * RED: runner event auth is read from authTokenFile not authTokenEnv.
     * The contract schema must accept authTokenFile in place of (or
     * alongside) authTokenEnv on the events block.
     */
    it("accepts authTokenFile on the events schema", async () => {
      const { parseRunnerCommandPayload } = await loadContractModule();

      // Build a valid payload with authTokenFile
      const payload = {
        ...validPayload(),
        events: {
          ...validEvents(),
          authTokenFile: "/etc/pipeline/event-auth/token",
        },
      };

      const parsed = parseRunnerCommandPayload(JSON.stringify(payload));

      expect(parsed.events.authTokenFile).toBe(
        "/etc/pipeline/event-auth/token"
      );
    });

    it("resolves auth token from file path when authTokenFile is set", async () => {
      const { resolveRunnerEventSinkAuthToken } = await loadContractModule();

      // resolveRunnerEventSinkAuthToken must accept an authTokenFile
      // option, read the file, and return the contents.
      const token = resolveRunnerEventSinkAuthToken({
        authTokenFile: "/etc/pipeline/event-auth/token",
        readFile: () => "file-based-token",
      });

      expect(token).toBe("file-based-token");
    });
  });

  it("does not export the env-based payload helper from the contract module", async () => {
    const contract = await loadContractModule();

    expect(contract).not.toHaveProperty("createRunnerCommandPayloadEnv");
    expect(contract).not.toHaveProperty("RUNNER_PAYLOAD_ENV");
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
