import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const RUNNER_PAYLOAD_ENV = "OISIN_PIPELINE_RUNNER_PAYLOAD_JSON";
const EVENT_SINK_URL = "https://console.example.test/api/runs/run_123/events";
const PAYLOAD_ENV_RE = /OISIN_PIPELINE_RUNNER_PAYLOAD_JSON/i;
const MALFORMED_JSON_RE = /malformed|json/i;
const EVENT_SINK_URL_RE = /eventSink\.url/i;
const STARTUP_FAILURE_RE = /runtime startup failed/i;
const MISSING_CONFIG_RE = /pipeline.*config|pipeline\.yaml/i;
const KUBERNETES_API_RE = /kubernetes|api\/v1|apis\/batch/i;
const FLUSH_FAILURE_RE = /console unavailable|event sink flush/i;
const UNAUTHORIZED_RE = /unauthorized|401|event sink flush/i;

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

function runtimeResult(outcome: "CANCELLED" | "FAIL" | "PASS"): any {
  return {
    agentInvocations: [],
    failureDetails:
      outcome === "FAIL"
        ? [{ evidence: [], gate: "runtime", reason: "failed" }]
        : [],
    gates: [],
    hookFailures: [],
    nodeStates: {},
    nodes: [],
    outcome,
    plan: { workflowId: "default" },
  };
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
  } as Response;
}

function unauthorizedResponse(): Response {
  return {
    ok: false,
    status: 401,
    text: () => Promise.resolve("unauthorized"),
  } as Response;
}

function loadRunnerModule(): Promise<Record<string, any>> {
  return import("../src/kubernetes-runner.js");
}

function ioBuffers(): {
  stderr: { write(chunk: string | Uint8Array): boolean };
  stderrText: () => string;
  stdout: { write(chunk: string | Uint8Array): boolean };
  stdoutText: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr.push(String(chunk));
        return true;
      },
    },
    stderrText: () => stderr.join(""),
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout.push(String(chunk));
        return true;
      },
    },
    stdoutText: () => stdout.join(""),
  };
}

function payloadEnv(
  payload: Record<string, unknown> = validPayload()
): Record<string, string> {
  return {
    OISIN_PIPELINE_EVENT_AUTH_TOKEN: "console-token",
    [RUNNER_PAYLOAD_ENV]: JSON.stringify(payload),
  };
}

describe("kubernetes runner-job entrypoint", () => {
  it("returns EX_USAGE 64 when the runner payload env var is missing", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();

    const exitCode = await runKubernetesRunnerJob({
      env: {},
      pipelineRunner,
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(64);
    expect(pipelineRunner).not.toHaveBeenCalled();
    expect(io.stderrText()).toMatch(PAYLOAD_ENV_RE);
  });

  it("returns EX_USAGE 64 for malformed runner payload JSON", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();

    const exitCode = await runKubernetesRunnerJob({
      env: { [RUNNER_PAYLOAD_ENV]: "{" },
      pipelineRunner,
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(64);
    expect(pipelineRunner).not.toHaveBeenCalled();
    expect(io.stderrText()).toMatch(MALFORMED_JSON_RE);
  });

  it("passes runId, workflowId, task, worktreePath, signal, and reporter to runPipelineFromConfig", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn(async () => okResponse());
    const pipelineRunner = vi.fn((options) => {
      expect(options).toEqual(
        expect.objectContaining({
          runId: "run_123",
          task: "Ship PIPE-38",
          workflowId: "default",
          worktreePath: "/workspace/run_123",
        })
      );
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(typeof options.reporter).toBe("function");
      options.reporter({
        attempt: 1,
        nodeId: "red",
        profile: "pipeline-test-writer",
        runnerId: "codex",
        type: "node.start",
      });
      return runtimeResult("PASS");
    });

    const exitCode = await runKubernetesRunnerJob({
      cwd: "/workspace/run_123",
      env: payloadEnv(),
      fetch: fetchMock,
      pipelineRunner,
    });

    expect(exitCode).toBe(0);
    expect(pipelineRunner).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as [
      string,
      RequestInit | undefined,
    ][];
    const [url, init] = calls[0];
    expect(url).toBe(EVENT_SINK_URL);
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).get("Authorization")).toBe(
      "Bearer console-token"
    );
  });

  it.each([
    ["PASS", 0],
    ["FAIL", 1],
    ["CANCELLED", 130],
  ] as const)("maps runtime outcome %s to exit code %i", async (outcome, expectedExitCode) => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();

    const exitCode = await runKubernetesRunnerJob({
      env: payloadEnv(),
      fetch: vi.fn(async () => okResponse()),
      pipelineRunner: vi.fn(async () => runtimeResult(outcome)),
    });

    expect(exitCode).toBe(expectedExitCode);
  });

  it("returns EX_USAGE 64 for runner payload validation failures", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();
    const payload = {
      ...validPayload(),
      eventSink: { authHeader: "Authorization", url: "not a url" },
    };

    const exitCode = await runKubernetesRunnerJob({
      env: payloadEnv(payload),
      pipelineRunner,
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(64);
    expect(pipelineRunner).not.toHaveBeenCalled();
    expect(io.stderrText()).toMatch(EVENT_SINK_URL_RE);
  });

  it("returns EX_SOFTWARE 70 when startup fails before a runtime result is available", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    const exitCode = await runKubernetesRunnerJob({
      env: payloadEnv(),
      fetch: vi.fn(async () => okResponse()),
      pipelineRunner: vi.fn(() =>
        Promise.reject(new Error("runtime startup failed"))
      ),
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(70);
    expect(io.stderrText()).toMatch(STARTUP_FAILURE_RE);
  });

  it("returns EX_USAGE 64 when the target pipeline config is missing", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-missing-config-"));

    try {
      const exitCode = await runKubernetesRunnerJob({
        cwd: dir,
        env: payloadEnv(),
        fetch: vi.fn(async () => okResponse()),
        stderr: io.stderr,
        stdout: io.stdout,
      });

      expect(exitCode).toBe(64);
      expect(io.stderrText()).toMatch(MISSING_CONFIG_RE);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("treats terminal event sink failures as runner failures", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    const exitCode = await runKubernetesRunnerJob({
      env: payloadEnv(),
      fetch: vi.fn(async () => unauthorizedResponse()),
      pipelineRunner: vi.fn(async () => runtimeResult("PASS")),
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(70);
    expect(io.stderrText()).toMatch(UNAUTHORIZED_RE);
  });

  it("does not call the Kubernetes API while running the in-pod job", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe(EVENT_SINK_URL);
      return Promise.resolve(okResponse());
    });

    await runKubernetesRunnerJob({
      env: payloadEnv(),
      fetch: fetchMock,
      pipelineRunner: vi.fn(async () => runtimeResult("PASS")),
    });

    const urls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .join("\n");
    expect(urls).not.toMatch(KUBERNETES_API_RE);
  });

  it("aborts the runtime on SIGTERM, flushes the CANCELLED result, and exits 130", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const signals = new EventEmitter();
    const fetchMock = vi.fn(async () => okResponse());
    const pipelineRunner = vi.fn((options) => {
      signals.emit("SIGTERM");
      expect(options.signal.aborted).toBe(true);
      return runtimeResult("CANCELLED");
    });

    const exitCode = await runKubernetesRunnerJob({
      env: payloadEnv(),
      fetch: fetchMock,
      pipelineRunner,
      signalEmitter: signals,
    });

    expect(exitCode).toBe(130);
    const lastCall = fetchMock.mock.calls.at(-1) as
      | [RequestInfo | URL, RequestInit]
      | undefined;
    expect(JSON.stringify(JSON.parse(String(lastCall?.[1].body)))).toContain(
      '"outcome":"CANCELLED"'
    );
  });

  it("aborts the runtime on SIGINT and preserves the cancelled exit code when final flush fails", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const signals = new EventEmitter();
    const io = ioBuffers();
    const pipelineRunner = vi.fn((options) => {
      signals.emit("SIGINT");
      expect(options.signal.aborted).toBe(true);
      return runtimeResult("CANCELLED");
    });

    const exitCode = await runKubernetesRunnerJob({
      env: payloadEnv(),
      fetch: vi.fn(() => Promise.reject(new Error("console unavailable"))),
      pipelineRunner,
      signalEmitter: signals,
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(130);
    expect(io.stderrText()).toMatch(FLUSH_FAILURE_RE);
  });

  it("treats a second signal as an immediate hard-exit request", async () => {
    const { runKubernetesRunnerJob } = await loadRunnerModule();
    const signals = new EventEmitter();
    const onForceExit = vi.fn();
    const pipelineRunner = vi.fn(() => {
      signals.emit("SIGTERM");
      signals.emit("SIGTERM");
      return runtimeResult("CANCELLED");
    });

    await runKubernetesRunnerJob({
      env: payloadEnv(),
      fetch: vi.fn(async () => okResponse()),
      onForceExit,
      pipelineRunner,
      signalEmitter: signals,
    });

    expect(onForceExit).toHaveBeenCalledWith(130);
  });
});
