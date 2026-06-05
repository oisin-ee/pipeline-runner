import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultPipelineScaffoldFiles } from "../src/pipeline-init.js";

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
}));

const EVENT_SINK_URL = "https://console.example.test/api/runs/run_123/events";
const RUNNER_JOB_CONTRACT_VERSION = "1";
const MALFORMED_JSON_RE = /malformed|json/i;
const REPOSITORY_URL_RE = /repository\.url/i;
const STARTUP_FAILURE_RE = /runtime startup failed/i;
const MISSING_CONFIG_RE = /pipeline.*config|pipeline\.yaml/i;
const KUBERNETES_API_RE = /kubernetes|api\/v1|apis\/batch/i;
const FLUSH_FAILURE_RE = /console unavailable|event sink flush/i;
const UNAUTHORIZED_RE = /unauthorized|401|event sink flush/i;
const SCHEMA_VALIDATION_RE = /schema validation|selector/i;
const SCHEMA_VALIDATION_MESSAGE_RE = /schema validation/i;
const PAYLOAD_FILE_REQUIRED_RE = /payload.*file/i;
const PAYLOAD_FILE_ERROR_RE = /payload.*file|file.*payload|not found|ENOENT/i;
const PAYLOAD_MALFORMED_JSON_RE =
  /malformed|Unexpected token|JSON.*error|error.*JSON/i;
const AUTH_FILE_MISSING_RE = /auth.*file|file.*auth|token|ENOENT/i;
const INVALID_ORCHESTRATOR_RE = /invalid orchestrator/i;
const RUNTIME_FAILURE_DETAILS_RE = /runtime failed.*gate: runtime.*failed/is;
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

async function writePipelineFixture(root: string): Promise<void> {
  for (const [path, content] of Object.entries(
    defaultPipelineScaffoldFiles()
  )) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function validPayload(): Record<string, unknown> {
  return {
    contractVersion: RUNNER_JOB_CONTRACT_VERSION,
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
  };
}

function validEvents(): Record<string, unknown> {
  return {
    authHeader: "Authorization",
    authTokenFile: "/tmp/placeholder-event-token",
    url: EVENT_SINK_URL,
  };
}

interface PayloadContext {
  dir: string;
  env: { PIPELINE_TARGET_PATH: string };
  payloadFile: string;
}

async function withPayloadContext<T>(
  fn: (ctx: PayloadContext) => Promise<T>,
  overrides?: Record<string, unknown>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pipe-test-"));
  try {
    const authTokenFilePath = join(dir, "event-token");
    await writeFile(authTokenFilePath, "console-token");
    const payload = {
      ...validPayload(),
      events: {
        ...validEvents(),
        authTokenFile: authTokenFilePath,
      },
      ...overrides,
    };
    const payloadFile = join(dir, "payload.json");
    await writeFile(payloadFile, JSON.stringify(payload));
    return fn({
      dir,
      env: { PIPELINE_TARGET_PATH: process.cwd() },
      payloadFile,
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
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

async function writeTestSkills(root: string): Promise<void> {
  for (const skill of TEST_SKILLS) {
    const skillDir = join(root, ".agents", "skills", skill);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `# ${skill}\n`);
  }
}

describe("runner-job entrypoint", () => {
  it("returns EX_USAGE 64 when payloadFile is not provided", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();

    const exitCode = await runRunnerJob({
      pipelineRunner,
      stderr: io.stderr,
    });

    expect(exitCode).toBe(64);
    expect(pipelineRunner).not.toHaveBeenCalled();
    expect(io.stderrText()).toMatch(PAYLOAD_FILE_REQUIRED_RE);
  });

  it("returns EX_USAGE 64 for malformed runner payload JSON", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-payload-malformed-"));
    const io = ioBuffers();
    try {
      const payloadPath = join(dir, "payload.json");
      await writeFile(payloadPath, "{");
      const exitCode = await runRunnerJob({
        payloadFile: payloadPath,
        stderr: io.stderr,
      });

      expect(exitCode).toBe(64);
      expect(io.stderrText()).toMatch(MALFORMED_JSON_RE);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
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

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
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
  });

  it("resolves ticket payloads before invoking the pipeline engine", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse()
    );
    const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

    const dir = await mkdtemp(join(tmpdir(), "pipe-ticket-payload-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadPath = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        events: {
          ...validEvents(),
          authTokenFile: authTokenFilePath,
        },
        task: {
          id: "PIPE-49.2",
          kind: "ticket",
        },
      };
      await writeFile(payloadPath, JSON.stringify(payload));

      const exitCode = await runRunnerJob({
        env: { PIPELINE_TARGET_PATH: process.cwd() },
        payloadFile: payloadPath,
        fetch: fetchMock,
        pipelineRunner,
      });

      expect(exitCode).toBe(0);
      expect(pipelineRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "PIPE-49.2",
          workflowId: "default",
        })
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("prepares repository workspaces before invoking the pipeline engine", async () => {
    const { runRunnerJob } = await loadRunnerModule();
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
      await writePipelineFixture(dir);
      const pipelineConfigPath = join(dir, ".pipeline", "pipeline.yaml");
      await writeFile(
        pipelineConfigPath,
        `${await readFile(pipelineConfigPath, "utf8")}\nrunner_job:\n  environment:\n    smoke:\n      - command: bun\n        args: ["run", "test:smoke"]\n`
      );

      const payloadFile = join(dir, "payload.json");
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payload = {
        ...validPayload(),
        delivery: { pullRequest: true },
        events: {
          ...validEvents(),
          authTokenFile: authTokenFilePath,
        },
        repository: {
          baseBranch: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/oisin-ee/tova.git",
        },
      };
      await writeFile(payloadFile, JSON.stringify(payload));

      const exitCode = await runRunnerJob({
        payloadFile,
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
      expect(runDevspaceCommand).not.toHaveBeenCalled();
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
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-no-devspace-"));
    const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

    try {
      await writeTestSkills(dir);
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadFile = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        events: {
          ...validEvents(),
          authTokenFile: authTokenFilePath,
        },
        repository: {
          baseBranch: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/oisin-ee/tova.git",
        },
      };
      await writeFile(payloadFile, JSON.stringify(payload));

      const exitCode = await runRunnerJob({
        payloadFile,
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

  it("ignores repo-local smoke config when preparing runner jobs", async () => {
    const { runRunnerJob } = await loadRunnerModule();
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
      await writePipelineFixture(dir);
      const pipelineConfigPath = join(dir, ".pipeline", "pipeline.yaml");
      await writeFile(
        pipelineConfigPath,
        `${await readFile(pipelineConfigPath, "utf8")}\nrunner_job:\n  environment:\n    smoke:\n      - command: bun\n        args: ["run", "test:smoke"]\n`
      );

      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadFile = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        delivery: { pullRequest: true },
        events: {
          ...validEvents(),
          authTokenFile: authTokenFilePath,
        },
        repository: {
          baseBranch: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/oisin-ee/tova.git",
        },
      };
      await writeFile(payloadFile, JSON.stringify(payload));

      const runDevspaceCommand = vi.fn(() =>
        Promise.reject(new Error("smoke failed"))
      );
      const exitCode = await runRunnerJob({
        payloadFile,
        fetch: fetchMock,
        pipelineRunner: vi.fn(() => runtimeResult("PASS")),
        prepareWorkspace: vi.fn(async () => ({
          env: { PIPELINE_TARGET_PATH: dir },
          worktreePath: dir,
        })),
        createPullRequest,
        runDevspaceCommand,
      });

      expect(exitCode).toBe(0);
      expect(runDevspaceCommand).not.toHaveBeenCalled();
      expect(createPullRequest).toHaveBeenCalledTimes(1);
      const postedEvents = postedBodies.flatMap((postedBody) => {
        const body = JSON.parse(postedBody) as {
          events: Array<{ log?: { message: string }; type: string }>;
        };
        return body.events;
      });
      expect(JSON.stringify(postedEvents)).not.toContain(
        "runner environment smoke failed"
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

    await withPayloadContext(async ({ env, payloadFile }) => {
      const io = ioBuffers();
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner: vi.fn(async () => runtimeResult(outcome)),
        stderr: io.stderr,
        stdout: io.stdout,
      });

      expect(exitCode).toBe(expectedExitCode);
    });
  });

  it("prints runtime failure details for FAIL outcomes", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner: vi.fn(async () => runtimeResult("FAIL")),
        stderr: io.stderr,
        stdout: io.stdout,
      });

      expect(exitCode).toBe(1);
      expect(io.stderrText()).toMatch(RUNTIME_FAILURE_DETAILS_RE);
    });
  });

  it("returns EX_USAGE 64 for runner payload validation failures", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const pipelineRunner = vi.fn();
    const io = ioBuffers();

    const dir = await mkdtemp(join(tmpdir(), "pipe-payload-validation-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadPath = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        events: {
          ...validEvents(),
          authTokenFile: authTokenFilePath,
        },
        repository: {
          baseBranch: "main",
          url: "not a url",
        },
      };
      await writeFile(payloadPath, JSON.stringify(payload));

      const exitCode = await runRunnerJob({
        payloadFile: payloadPath,
        pipelineRunner,
        stderr: io.stderr,
      });

      expect(exitCode).toBe(64);
      expect(pipelineRunner).not.toHaveBeenCalled();
      expect(io.stderrText()).toMatch(REPOSITORY_URL_RE);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("posts schema validation events when an invalid payload still has run and sink identity", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn(async () => okResponse());
    const pipelineRunner = vi.fn();
    const io = ioBuffers();

    const dir = await mkdtemp(join(tmpdir(), "pipe-schema-validation-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadPath = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        events: {
          ...validEvents(),
          authTokenFile: authTokenFilePath,
        },
        selector: {
          unexpected: "quick",
          workflowId: "default",
        },
      };
      await writeFile(payloadPath, JSON.stringify(payload));

      const exitCode = await runRunnerJob({
        payloadFile: payloadPath,
        fetch: fetchMock,
        pipelineRunner,
        stderr: io.stderr,
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
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns EX_SOFTWARE 70 when startup fails before a runtime result is available", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();
    const fetchMock = vi.fn(async () => okResponse());

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: fetchMock,
        pipelineRunner: vi.fn(() =>
          Promise.reject(new Error("runtime startup failed"))
        ),
        stderr: io.stderr,
      });

      expect(exitCode).toBe(70);
      expect(io.stderrText()).toMatch(STARTUP_FAILURE_RE);
      expect(fetchMock.mock.calls[0]).toBeDefined();
      const body = JSON.parse(
        String(
          (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body
        )
      ) as { events: Record<string, unknown>[] };
      expect(body.events).toContainEqual(
        expect.objectContaining({
          finalResult: {
            outcome: "FAIL",
            workflowId: "pipe",
          },
          type: "workflow.finish",
        })
      );
    });
  });

  it("uses package config when the target repo has no pipeline config", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-missing-config-"));
    const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadFile = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        events: {
          ...validEvents(),
          authTokenFile: authTokenFilePath,
        },
      };
      await writeFile(payloadFile, JSON.stringify(payload));

      const exitCode = await runRunnerJob({
        cwd: dir,
        payloadFile,
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner,
        stderr: io.stderr,
      });

      expect(exitCode).toBe(0);
      expect(io.stderrText()).not.toMatch(MISSING_CONFIG_RE);
      expect(pipelineRunner).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("ignores target repo pipeline config when spawning runner jobs", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-repo-config-"));
    const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

    try {
      await mkdir(join(dir, ".pipeline"), { recursive: true });
      await writeFile(
        join(dir, ".pipeline", "runners.yaml"),
        "version: 1\nrunners:\n  opencode:\n    type: opencode\n    model: opencode/deepseek-v4-flash-free\n    capabilities: { tools: [bash] }\n"
      );
      await writeFile(
        join(dir, ".pipeline", "profiles.yaml"),
        "version: 1\nprofiles: {}\n"
      );
      await writeFile(
        join(dir, ".pipeline", "pipeline.yaml"),
        "version: 1\ndefault_workflow: repo-local\norchestrator: { profile: repo-local }\nworkflows: {}\n"
      );
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadFile = join(dir, "payload.json");
      await writeFile(
        payloadFile,
        JSON.stringify({
          ...validPayload(),
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );

      const exitCode = await runRunnerJob({
        cwd: dir,
        payloadFile,
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner,
      });

      expect(exitCode).toBe(0);
      expect(pipelineRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            default_workflow: "default",
          }),
          workflowId: "default",
        })
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("treats terminal event sink failures as runner failures", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: vi.fn(async () => unauthorizedResponse()),
        pipelineRunner: vi.fn(async () => runtimeResult("PASS")),
        stderr: io.stderr,
      });

      expect(exitCode).toBe(70);
      expect(io.stderrText()).toMatch(UNAUTHORIZED_RE);
    });
  });

  it("does not call the Kubernetes API while running the in-pod job", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe(EVENT_SINK_URL);
      return Promise.resolve(okResponse());
    });

    await withPayloadContext(async ({ env, payloadFile }) => {
      await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: fetchMock,
        pipelineRunner: vi.fn(async () => runtimeResult("PASS")),
      });

      const urls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .join("\n");
      expect(urls).not.toMatch(KUBERNETES_API_RE);
    });
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

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
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

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: vi.fn(() => Promise.reject(new Error("console unavailable"))),
        pipelineRunner,
        signalEmitter: signals,
        stderr: io.stderr,
      });

      expect(exitCode).toBe(130);
      expect(io.stderrText()).toMatch(FLUSH_FAILURE_RE);
    });
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

    await withPayloadContext(async ({ env, payloadFile }) => {
      await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: vi.fn(async () => okResponse()),
        onForceExit,
        pipelineRunner,
        signalEmitter: signals,
      });

      expect(onForceExit).toHaveBeenCalledWith(130);
    });
  });
});

describe("runner-job payload from file", () => {
  it("reads the runner payload from a file path when payloadFile option is set", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-payload-file-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadPath = join(dir, "payload.json");
      await writeFile(
        payloadPath,
        JSON.stringify({
          ...validPayload(),
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );
      const fetchMock = vi.fn(async () => okResponse());
      const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env: { PIPELINE_TARGET_PATH: process.cwd() },
        fetch: fetchMock,
        payloadFile: payloadPath,
        pipelineRunner,
      });

      expect(exitCode).toBe(0);
      expect(pipelineRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run_123",
          task: "Ship PIPE-38",
        })
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns EX_USAGE 64 when payloadFile path does not exist", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    const exitCode = await runRunnerJob({
      payloadFile: "/tmp/nonexistent-payload.json",
      stderr: io.stderr,
    });

    expect(exitCode).toBe(64);
    expect(io.stderrText()).toMatch(PAYLOAD_FILE_ERROR_RE);
  });

  it("returns EX_USAGE 64 when payloadFile contains malformed JSON", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-payload-malformed-"));
    const io = ioBuffers();
    try {
      const payloadPath = join(dir, "payload.json");
      await writeFile(payloadPath, "not valid json");

      const exitCode = await runRunnerJob({
        payloadFile: payloadPath,
        stderr: io.stderr,
      });

      expect(exitCode).toBe(64);
      expect(io.stderrText()).toMatch(PAYLOAD_MALFORMED_JSON_RE);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("runner-job event auth from file", () => {
  it("reads the event auth token from authTokenFile when configured in payload", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-auth-file-"));
    try {
      const authFilePath = join(dir, "event-token");
      await writeFile(authFilePath, "file-based-token");
      const payloadPath = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        events: {
          authHeader: "Authorization",
          authTokenFile: authFilePath,
          url: EVENT_SINK_URL,
        },
      };
      await writeFile(payloadPath, JSON.stringify(payload));

      const fetchMock = vi.fn(async () => okResponse());
      const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env: { PIPELINE_TARGET_PATH: process.cwd() },
        fetch: fetchMock,
        payloadFile: payloadPath,
        pipelineRunner,
      });

      expect(exitCode).toBe(0);
      const calls = fetchMock.mock.calls as unknown as [
        string,
        RequestInit | undefined,
      ][];
      const [, init] = calls[0] ?? [];
      const headers = init?.headers as Headers | undefined;
      expect(headers?.get("Authorization")).toBe("Bearer file-based-token");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("fails gracefully when authTokenFile points to a missing file", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    const dir = await mkdtemp(join(tmpdir(), "pipe-auth-missing-"));
    try {
      const payloadPath = join(dir, "payload.json");
      const payload = {
        ...validPayload(),
        events: {
          authHeader: "Authorization",
          authTokenFile: "/tmp/missing-event-token",
          url: EVENT_SINK_URL,
        },
      };
      await writeFile(payloadPath, JSON.stringify(payload));

      const exitCode = await runRunnerJob({
        payloadFile: payloadPath,
        stderr: io.stderr,
      });

      expect(exitCode).toBe(64);
      expect(io.stderrText()).toMatch(AUTH_FILE_MISSING_RE);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("runner-job orchestrator argument", () => {
  it("accepts a valid codex orchestrator arg without error", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-orch-codex-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadPath = join(dir, "payload.json");
      await writeFile(
        payloadPath,
        JSON.stringify({
          ...validPayload(),
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );

      const exitCode = await runRunnerJob({
        env: { PIPELINE_TARGET_PATH: process.cwd() },
        payloadFile: payloadPath,
        orchestrator: "codex",
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner: vi.fn(() => runtimeResult("PASS")),
      });

      expect(exitCode).toBe(0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("accepts a valid opencode orchestrator arg without error", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-orch-opencode-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadPath = join(dir, "payload.json");
      await writeFile(
        payloadPath,
        JSON.stringify({
          ...validPayload(),
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );

      const pipelineRunner = vi.fn(() => runtimeResult("PASS"));

      const exitCode = await runRunnerJob({
        env: { PIPELINE_TARGET_PATH: process.cwd() },
        payloadFile: payloadPath,
        orchestrator: "opencode",
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner,
      });

      expect(exitCode).toBe(0);
      expect(pipelineRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            profiles: expect.objectContaining({
              "pipeline-researcher": expect.objectContaining({
                runner: "opencode",
              }),
              "pipeline-code-writer": expect.objectContaining({
                runner: "opencode",
              }),
            }),
          }),
        })
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects invalid orchestrator values with EX_USAGE 64", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();

    const exitCode = await runRunnerJob({
      payloadFile: "/tmp/nonexistent.json",
      orchestrator: "invalid-orchestrator",
      stderr: io.stderr,
    });

    expect(exitCode).toBe(64);
    expect(io.stderrText()).toMatch(INVALID_ORCHESTRATOR_RE);
  });

  it("accepts undefined orchestrator (optional) without error", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-orch-none-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadPath = join(dir, "payload.json");
      await writeFile(
        payloadPath,
        JSON.stringify({
          ...validPayload(),
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );

      const exitCode = await runRunnerJob({
        env: { PIPELINE_TARGET_PATH: process.cwd() },
        payloadFile: payloadPath,
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner: vi.fn(() => runtimeResult("PASS")),
      });

      expect(exitCode).toBe(0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
