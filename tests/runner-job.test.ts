import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
}));

const RUNNER_PAYLOAD_ENV = "OISIN_PIPELINE_RUNNER_PAYLOAD_JSON";
const EVENT_SINK_URL = "https://console.example.test/api/runs/run_123/events";
const RUNNER_JOB_CONTRACT_VERSION = "1";
const PAYLOAD_ENV_RE = /OISIN_PIPELINE_RUNNER_PAYLOAD_JSON/i;
const MALFORMED_JSON_RE = /malformed|json/i;
const REPOSITORY_URL_RE = /repository\.url/i;
const STARTUP_FAILURE_RE = /runtime startup failed/i;
const MISSING_CONFIG_RE = /pipeline.*config|pipeline\.yaml/i;
const KUBERNETES_API_RE = /kubernetes|api\/v1|apis\/batch/i;
const FLUSH_FAILURE_RE = /console unavailable|event sink flush/i;
const UNAUTHORIZED_RE = /unauthorized|401|event sink flush/i;
const SCHEMA_VALIDATION_RE = /schema validation|selector/i;
const SCHEMA_VALIDATION_MESSAGE_RE = /schema validation/i;
const SMOKE_FAILED_RE = /smoke failed/i;
const TEST_SKILLS = [
  "critique",
  "diagnose",
  "doubt",
  "fix",
  "improve",
  "library-first-development",
  "migrate",
  "optimize",
  "research",
  "scope",
  "secure",
  "spec",
  "test",
  "trace",
  "verify",
];

function validPayload(): Record<string, unknown> {
  return {
    contractVersion: RUNNER_JOB_CONTRACT_VERSION,
    delivery: { pullRequest: false },
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
  return import("../src/runner-job/run.js");
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
): Record<string, string | undefined> {
  return {
    OISIN_PIPELINE_EVENT_AUTH_TOKEN: "console-token",
    OISIN_PIPELINE_EVENT_SINK_URL: EVENT_SINK_URL,
    PIPELINE_TARGET_PATH: process.cwd(),
    [RUNNER_PAYLOAD_ENV]: JSON.stringify(payload),
  };
}

async function writeTestSkills(root: string): Promise<void> {
  for (const skill of TEST_SKILLS) {
    const skillDir = join(root, ".agents", "skills", skill);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `# ${skill}\n`);
  }
}

describe("runner-job entrypoint", () => {
  it("returns EX_USAGE 64 when the runner payload env var is missing", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();

    const exitCode = await runRunnerJob({
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
    const { runRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();

    const exitCode = await runRunnerJob({
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
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse()
    );
    const pipelineRunner = vi.fn((options) => {
      expect(options).toEqual(
        expect.objectContaining({
          hookPolicy: expect.objectContaining({
            allowCommandHooks: true,
          }),
          runId: "run_123",
          task: "Ship PIPE-38",
          workflowId: "default",
          worktreePath: process.cwd(),
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

    const exitCode = await runRunnerJob({
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

  it("resolves ticket payloads before invoking the pipeline engine", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse()
    );
    const pipelineRunner = vi.fn((options) => {
      expect(options).toEqual(
        expect.objectContaining({
          hookPolicy: expect.objectContaining({
            allowCommandHooks: true,
          }),
          task: "PIPE-49.2",
          workflowId: "default",
        })
      );
      return runtimeResult("PASS");
    });

    const exitCode = await runRunnerJob({
      env: payloadEnv({
        ...validPayload(),
        task: {
          id: "PIPE-49.2",
          kind: "ticket",
        },
      }),
      fetch: fetchMock,
      pipelineRunner,
    });

    expect(exitCode).toBe(0);
    expect(pipelineRunner).toHaveBeenCalledTimes(1);
  });

  it("prepares repository workspaces before invoking the pipeline engine", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const { initPipelineProject } = await import("../src/pipeline-init.js");
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-devspace-"));
    const postedBodies: string[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      postedBodies.push(String(init?.body));
      return Promise.resolve(okResponse());
    });
    const prepareWorkspace = vi.fn(async () => ({
      env: { PIPELINE_TARGET_PATH: dir },
      worktreePath: dir,
    }));
    const pipelineRunner = vi.fn((options) => {
      expect(options.worktreePath).toBe(dir);
      return runtimeResult("PASS");
    });
    const createPullRequest = vi.fn(async () => ({
      url: "https://github.com/oisin-ee/tova/pull/123",
    }));
    const runDevspaceCommand = vi.fn(async () => undefined);

    try {
      await writeTestSkills(dir);
      await initPipelineProject({ cwd: dir, overwrite: false });
      const pipelineConfigPath = join(dir, ".pipeline", "pipeline.yaml");
      await writeFile(
        pipelineConfigPath,
        `${await readFile(pipelineConfigPath, "utf8")}\nrunner_job:\n  environment:\n    smoke:\n      - command: bun\n        args: ["run", "test:smoke"]\n`
      );

      const exitCode = await runRunnerJob({
        env: payloadEnv({
          ...validPayload(),
          delivery: { pullRequest: true },
          repository: {
            baseBranch: "main",
            sha: "0123456789abcdef0123456789abcdef01234567",
            url: "https://github.com/oisin-ee/tova.git",
          },
        }),
        fetch: fetchMock,
        pipelineRunner,
        prepareWorkspace,
        createPullRequest,
        runDevspaceCommand,
      });

      expect(exitCode).toBe(0);
      expect(prepareWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            repository: expect.objectContaining({
              url: "https://github.com/oisin-ee/tova.git",
            }),
          }),
        })
      );
      expect(pipelineRunner).toHaveBeenCalledTimes(1);
      expect(runDevspaceCommand).toHaveBeenCalledWith(
        "bun",
        ["run", "test:smoke"],
        {
          cwd: dir,
          env: expect.objectContaining({ PIPELINE_TARGET_PATH: dir }),
          stdin: "ignore",
        }
      );
      expect(createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            repository: expect.objectContaining({
              url: "https://github.com/oisin-ee/tova.git",
            }),
          }),
          worktreePath: dir,
        })
      );
      expect(runDevspaceCommand.mock.invocationCallOrder[0]).toBeLessThan(
        createPullRequest.mock.invocationCallOrder[0] ?? 0
      );
      const postedEvents = postedBodies.flatMap((postedBody) => {
        const body = JSON.parse(postedBody) as {
          events: Array<{ log?: { message: string }; type: string }>;
        };
        return body.events;
      });
      expect(postedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            log: expect.objectContaining({
              message: "runner workspace prepared",
            }),
            type: "runner.job.phase",
          }),
          expect.objectContaining({
            log: expect.objectContaining({
              message: "runner environment ready",
            }),
            type: "runner.job.phase",
          }),
          expect.objectContaining({
            log: expect.objectContaining({
              message: "runner environment smoke ran",
            }),
            type: "runner.job.phase",
          }),
          expect.objectContaining({
            log: expect.objectContaining({
              message: "runner pull request created",
              output: expect.objectContaining({
                url: "https://github.com/oisin-ee/tova/pull/123",
              }),
            }),
            type: "runner.job.phase",
          }),
        ])
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not require devspace.yaml before invoking the pipeline engine", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const { initPipelineProject } = await import("../src/pipeline-init.js");
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-no-devspace-"));
    const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

    try {
      await writeTestSkills(dir);
      await initPipelineProject({ cwd: dir, overwrite: false });
      const exitCode = await runRunnerJob({
        env: payloadEnv({
          ...validPayload(),
          repository: {
            baseBranch: "main",
            sha: "0123456789abcdef0123456789abcdef01234567",
            url: "https://github.com/oisin-ee/tova.git",
          },
        }),
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner,
        prepareWorkspace: vi.fn(async () => ({
          env: { PIPELINE_TARGET_PATH: dir },
          worktreePath: dir,
        })),
      });

      expect(exitCode).toBe(0);
      expect(pipelineRunner).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("records a failed smoke phase and does not create a PR when environment smoke fails", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const { initPipelineProject } = await import("../src/pipeline-init.js");
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-smoke-fail-"));
    const postedBodies: string[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      postedBodies.push(String(init?.body));
      return Promise.resolve(okResponse());
    });
    const createPullRequest = vi.fn(async () => ({
      url: "https://github.com/oisin-ee/tova/pull/123",
    }));

    try {
      await writeTestSkills(dir);
      await initPipelineProject({ cwd: dir, overwrite: false });
      const pipelineConfigPath = join(dir, ".pipeline", "pipeline.yaml");
      await writeFile(
        pipelineConfigPath,
        `${await readFile(pipelineConfigPath, "utf8")}\nrunner_job:\n  environment:\n    smoke:\n      - command: bun\n        args: ["run", "test:smoke"]\n`
      );

      const exitCode = await runRunnerJob({
        env: payloadEnv({
          ...validPayload(),
          delivery: { pullRequest: true },
          repository: {
            baseBranch: "main",
            sha: "0123456789abcdef0123456789abcdef01234567",
            url: "https://github.com/oisin-ee/tova.git",
          },
        }),
        fetch: fetchMock,
        pipelineRunner: vi.fn(() => runtimeResult("PASS")),
        prepareWorkspace: vi.fn(async () => ({
          env: { PIPELINE_TARGET_PATH: dir },
          worktreePath: dir,
        })),
        createPullRequest,
        runDevspaceCommand: vi.fn(() =>
          Promise.reject(new Error("smoke failed"))
        ),
      });

      expect(exitCode).toBe(70);
      expect(createPullRequest).not.toHaveBeenCalled();
      const postedEvents = postedBodies.flatMap((postedBody) => {
        const body = JSON.parse(postedBody) as {
          events: Array<{ log?: { message: string }; type: string }>;
        };
        return body.events;
      });
      expect(postedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            log: expect.objectContaining({
              message: "runner environment smoke failed",
              output: expect.objectContaining({
                error: expect.stringMatching(SMOKE_FAILED_RE),
              }),
            }),
            type: "runner.job.phase",
          }),
        ])
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.each([
    ["PASS", 0],
    ["FAIL", 1],
    ["CANCELLED", 130],
  ] as const)("maps runtime outcome %s to exit code %i", async (outcome, expectedExitCode) => {
    const { runRunnerJob } = await loadRunnerModule();

    const exitCode = await runRunnerJob({
      env: payloadEnv(),
      fetch: vi.fn(async () => okResponse()),
      pipelineRunner: vi.fn(async () => runtimeResult(outcome)),
    });

    expect(exitCode).toBe(expectedExitCode);
  });

  it("returns EX_USAGE 64 for runner payload validation failures", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();
    const payload = {
      ...validPayload(),
      repository: {
        baseBranch: "main",
        url: "not a url",
      },
    };

    const exitCode = await runRunnerJob({
      env: payloadEnv(payload),
      pipelineRunner,
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(64);
    expect(pipelineRunner).not.toHaveBeenCalled();
    expect(io.stderrText()).toMatch(REPOSITORY_URL_RE);
  });

  it("posts schema validation events when an invalid payload still has run and sink identity", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn(async () => okResponse());
    const pipelineRunner = vi.fn();
    const io = ioBuffers();
    const payload = {
      ...validPayload(),
      selector: {
        unexpected: "quick",
        workflowId: "default",
      },
    };

    const exitCode = await runRunnerJob({
      env: payloadEnv(payload),
      fetch: fetchMock,
      pipelineRunner,
      stderr: io.stderr,
      stdout: io.stdout,
    });

    expect(exitCode).toBe(64);
    expect(pipelineRunner).not.toHaveBeenCalled();
    expect(io.stderrText()).toMatch(SCHEMA_VALIDATION_RE);
    expect(fetchMock.mock.calls[0]).toBeDefined();
    const body = JSON.parse(
      String(
        (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body
      )
    ) as { events: Record<string, unknown>[] };
    expect(body.events).toEqual([
      expect.objectContaining({
        log: expect.objectContaining({
          level: "warn",
          message: expect.stringMatching(SCHEMA_VALIDATION_MESSAGE_RE),
        }),
        type: "runner.schema.validation",
      }),
      expect.objectContaining({
        finalResult: {
          outcome: "FAIL",
          workflowId: "pipe",
        },
        type: "workflow.finish",
      }),
    ]);
  });

  it("returns EX_SOFTWARE 70 when startup fails before a runtime result is available", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    const exitCode = await runRunnerJob({
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
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-missing-config-"));

    try {
      const env = payloadEnv();
      env.PIPELINE_TARGET_PATH = undefined;
      const exitCode = await runRunnerJob({
        cwd: dir,
        env,
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
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    const exitCode = await runRunnerJob({
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
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe(EVENT_SINK_URL);
      return Promise.resolve(okResponse());
    });

    await runRunnerJob({
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
    const { runRunnerJob } = await loadRunnerModule();
    const signals = new EventEmitter();
    const fetchMock = vi.fn(async () => okResponse());
    const pipelineRunner = vi.fn((options) => {
      signals.emit("SIGTERM");
      expect(options.signal.aborted).toBe(true);
      return runtimeResult("CANCELLED");
    });

    const exitCode = await runRunnerJob({
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
    const { runRunnerJob } = await loadRunnerModule();
    const signals = new EventEmitter();
    const io = ioBuffers();
    const pipelineRunner = vi.fn((options) => {
      signals.emit("SIGINT");
      expect(options.signal.aborted).toBe(true);
      return runtimeResult("CANCELLED");
    });

    const exitCode = await runRunnerJob({
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
    const { runRunnerJob } = await loadRunnerModule();
    const signals = new EventEmitter();
    const onForceExit = vi.fn();
    const pipelineRunner = vi.fn(() => {
      signals.emit("SIGTERM");
      signals.emit("SIGTERM");
      return runtimeResult("CANCELLED");
    });

    await runRunnerJob({
      env: payloadEnv(),
      fetch: vi.fn(async () => okResponse()),
      onForceExit,
      pipelineRunner,
      signalEmitter: signals,
    });

    expect(onForceExit).toHaveBeenCalledWith(130);
  });
});
