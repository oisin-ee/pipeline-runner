import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(() => ({ exitCode: 0, stderr: "", stdout: "" })),
}));

vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    add: vi.fn(async () => undefined),
    addConfig: vi.fn(async () => undefined),
    branch: vi.fn(async () => ({ current: "pipeline/run-123" })),
    branchLocal: vi.fn(async () => ({ branches: { "pipeline/run-123": {} } })),
    commit: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    revparse: vi.fn(async () => "abc123\n"),
    status: vi.fn(async () => ({ files: [] })),
  })),
}));

const EVENT_SINK_URL = "https://console.example.test/api/runs/run_123/events";
const RUNNER_JOB_CONTRACT_VERSION = "1";
const MALFORMED_JSON_RE = /malformed|json/i;
const REPOSITORY_URL_RE = /repository\.url/i;
const STARTUP_FAILURE_RE = /runtime startup failed/i;
const WORKSPACE_CLONE_FAILURE_RE = /workspace clone failed/i;
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
    structuredOutputs:
      outcome === "PASS"
        ? [
            {
              attempt: 1,
              format: "json_schema",
              nodeId: "green",
              output: {
                changes: [
                  {
                    files: ["src/app.ts"],
                    summary: "Implement runner task",
                    why: "The requested runner task needs code changes",
                  },
                ],
                verification: ["runner fixture verification passed"],
              },
              profileId: "pipeline-code-writer",
              schemaPath: ".pipeline/schemas/implementation.schema.json",
              validation: {
                evidence: [
                  "JSON schema passed: .pipeline/schemas/implementation.schema.json",
                ],
                passed: true,
                status: "valid",
              },
            },
          ]
        : [],
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

function runTypecheck(args: string[], options: { cwd: string }): string {
  try {
    return execFileSync(
      join(process.cwd(), "node_modules", ".bin", "tsc"),
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: "pipe",
      }
    );
  } catch (error) {
    const output = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    throw new Error(
      [output.message, output.stdout?.toString(), output.stderr?.toString()]
        .filter(Boolean)
        .join("\n")
    );
  }
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

async function writeIgnoredRepoLocalSmokeConfig(root: string): Promise<void> {
  const pipelineDir = join(root, ".pipeline");
  await mkdir(pipelineDir, { recursive: true });
  await writeFile(
    join(pipelineDir, "pipeline.yaml"),
    [
      "version: 1",
      "runner_job:",
      "  environment:",
      "    smoke:",
      "      - command: bun",
      '        args: ["run", "test:smoke"]',
      "",
    ].join("\n")
  );
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

  it("uses the ticket id, not the ticket file body, as schedule identity", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse()
    );
    const pipelineRunner = vi.fn(() => runtimeResult("PASS"));
    const prepareSchedule = vi.fn(async (config) => ({
      config,
      workflowId: "default",
    }));

    const dir = await mkdtemp(join(tmpdir(), "pipe-ticket-schedule-"));
    try {
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      await mkdir(join(dir, "backlog", "tasks"), { recursive: true });
      await writeFile(
        join(dir, "backlog", "tasks", "rondo-017.02.md"),
        [
          "---",
          "id: RONDO-017.02",
          "dependencies:",
          "  - RONDO-017.01",
          "---",
          "",
          "## Description",
          "Create integration tests for RONDO-017.02.",
        ].join("\n")
      );
      const payloadPath = join(dir, "payload.json");
      await writeFile(
        payloadPath,
        JSON.stringify({
          ...validPayload(),
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
          task: {
            id: "RONDO-017.02",
            kind: "ticket",
            path: "backlog/tasks/rondo-017.02.md",
          },
        })
      );

      const exitCode = await runRunnerJob({
        env: { PIPELINE_TARGET_PATH: dir },
        fetch: fetchMock,
        payloadFile: payloadPath,
        pipelineRunner,
        prepareSchedule,
      });

      expect(exitCode).toBe(0);
      expect(prepareSchedule).toHaveBeenCalledWith(
        expect.anything(),
        "RONDO-017.02",
        expect.objectContaining({ worktreePath: dir }),
        expect.anything()
      );
      expect(pipelineRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.stringContaining("dependencies:\n  - RONDO-017.01"),
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
    const io = ioBuffers();

    try {
      await writeTestSkills(dir);
      await writeIgnoredRepoLocalSmokeConfig(dir);

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
        stdout: io.stdout,
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
          pullRequestSummary: expect.objectContaining({
            body: expect.stringContaining(
              "Why: The requested runner task needs code changes"
            ),
            title: expect.stringContaining("Pipeline:"),
          }),
          worktreePath: dir,
        })
      );
      expect(io.stdoutText()).toContain("Runner delivery complete:");
      expect(io.stdoutText()).toContain("- branch: pipeline/run-123");
      expect(io.stdoutText()).toContain(
        "- pull_request: https://github.com/oisin-ee/tova/pull/123"
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

  it("flushes runner job phase events before schedule preparation completes", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-phase-flush-"));
    const postedBodies: string[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      postedBodies.push(String(init?.body));
      return Promise.resolve(okResponse());
    });
    let releaseSchedule: (() => void) | undefined;
    const scheduleGate = new Promise<void>((resolve) => {
      releaseSchedule = resolve;
    });
    const prepareSchedule = vi.fn(async (config) => {
      await scheduleGate;
      return { config, workflowId: "default" };
    });

    try {
      await writeTestSkills(dir);
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

      const runPromise = runRunnerJob({
        env: { PIPELINE_TARGET_PATH: dir },
        fetch: fetchMock,
        payloadFile,
        pipelineRunner: vi.fn(() => runtimeResult("PASS")),
        prepareSchedule,
        prepareWorkspace: vi.fn(async () => ({
          env: { PIPELINE_TARGET_PATH: dir },
          worktreePath: dir,
        })),
      });

      await vi.waitFor(() => {
        expect(prepareSchedule).toHaveBeenCalled();
      });

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
              message: "runner environment setup skipped",
            }),
            type: "runner.job.phase",
          }),
        ])
      );

      releaseSchedule?.();
      await expect(runPromise).resolves.toBe(0);
    } finally {
      releaseSchedule?.();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reconciles the gateway against the prepared runner workspace once", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-gateway-"));
    const prepareWorkspace = vi.fn(async () => ({
      env: { PIPELINE_TARGET_PATH: dir },
      worktreePath: dir,
    }));
    const reconcileGateway = vi.fn(async () => ({
      backendCount: 6,
      configPath: join(dir, ".pipeline/mcp-gateway/vmcp.yaml"),
      readinessFailures: [],
      workspacePath: dir,
    }));
    const pipelineRunner = vi.fn((options) => {
      expect(options.worktreePath).toBe(dir);
      return runtimeResult("PASS");
    });

    try {
      await writeTestSkills(dir);
      const payloadFile = join(dir, "payload.json");
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
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
        env: { PIPELINE_TARGET_PATH: dir },
        fetch: vi.fn(async () => okResponse()),
        payloadFile,
        pipelineRunner,
        prepareWorkspace,
        reconcileGateway,
      });

      expect(exitCode).toBe(0);
      expect(prepareWorkspace).toHaveBeenCalledTimes(1);
      expect(reconcileGateway).toHaveBeenCalledWith(
        expect.anything(),
        dir,
        expect.objectContaining({ PIPELINE_TARGET_PATH: dir })
      );
      expect(pipelineRunner).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("commits and pushes successful runner job changes without requiring a PR", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-git-delivery-"));
    const deliverGitBranch = vi.fn(async () => ({
      branch: "pipeline/run-123",
      commitSha: "abc123",
      pushed: true,
    }));
    const createPullRequest = vi.fn();

    try {
      await writeTestSkills(dir);
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadFile = join(dir, "payload.json");
      await writeFile(
        payloadFile,
        JSON.stringify({
          ...validPayload(),
          delivery: { pullRequest: false },
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );

      const exitCode = await runRunnerJob({
        payloadFile,
        fetch: vi.fn(async () => okResponse()),
        pipelineRunner: vi.fn(() => runtimeResult("PASS")),
        prepareWorkspace: vi.fn(async () => ({
          env: { PIPELINE_TARGET_PATH: dir },
          worktreePath: dir,
        })),
        deliverGitBranch,
        createPullRequest,
      });

      expect(exitCode).toBe(0);
      expect(deliverGitBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          committer: {
            email: "git@oisin.ee",
            name: "oisin-bot",
          },
          payload: expect.objectContaining({
            delivery: { pullRequest: false },
          }),
          worktreePath: dir,
        })
      );
      expect(createPullRequest).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not deliver failed runner job changes to a branch or PR", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-fail-delivery-"));
    const postedBodies: string[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      postedBodies.push(String(init?.body));
      return Promise.resolve(okResponse());
    });
    const deliverGitBranch = vi.fn(async () => ({
      branch: "pipeline/run-123",
      commitSha: "abc123",
      pushed: true,
    }));
    const createPullRequest = vi.fn(async () => ({
      url: "https://github.com/oisin-ee/tova/pull/456",
    }));
    const runDevspaceCommand = vi.fn(async () => undefined);
    const io = ioBuffers();

    try {
      await writeTestSkills(dir);
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadFile = join(dir, "payload.json");
      await writeFile(
        payloadFile,
        JSON.stringify({
          ...validPayload(),
          delivery: { pullRequest: true },
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );

      const exitCode = await runRunnerJob({
        payloadFile,
        fetch: fetchMock,
        pipelineRunner: vi.fn(() => runtimeResult("FAIL")),
        prepareWorkspace: vi.fn(async () => ({
          env: { PIPELINE_TARGET_PATH: dir },
          worktreePath: dir,
        })),
        deliverGitBranch,
        createPullRequest,
        runDevspaceCommand,
        stderr: io.stderr,
        stdout: io.stdout,
      });

      expect(exitCode).toBe(1);
      expect(runDevspaceCommand).not.toHaveBeenCalled();
      expect(deliverGitBranch).not.toHaveBeenCalled();
      expect(createPullRequest).not.toHaveBeenCalled();
      expect(io.stdoutText()).toBe("");
      expect(io.stderrText()).toMatch(RUNTIME_FAILURE_DETAILS_RE);

      const postedEvents = postedBodies.flatMap((postedBody) => {
        const body = JSON.parse(postedBody) as {
          events: Array<{ log?: { message: string }; type: string }>;
        };
        return body.events;
      });
      expect(postedEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            finalResult: expect.objectContaining({
              outcome: "FAIL",
            }),
            type: "workflow.finish",
          }),
        ])
      );
      expect(JSON.stringify(postedEvents)).not.toContain(
        "runner git branch pushed"
      );
      expect(JSON.stringify(postedEvents)).not.toContain(
        "runner pull request created"
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not mask failed runtime results with delivery errors because delivery is skipped", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const dir = await mkdtemp(
      join(tmpdir(), "pipe-runner-fail-delivery-error-")
    );
    const postedBodies: string[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      postedBodies.push(String(init?.body));
      return Promise.resolve(okResponse());
    });
    const deliverGitBranch = vi.fn(async () => ({
      branch: "pipeline/run-123",
      commitSha: "abc123",
      pushed: true,
    }));
    const createPullRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("pull request already exists"));
    const io = ioBuffers();

    try {
      await writeTestSkills(dir);
      const authTokenFilePath = join(dir, "event-token");
      await writeFile(authTokenFilePath, "console-token");
      const payloadFile = join(dir, "payload.json");
      await writeFile(
        payloadFile,
        JSON.stringify({
          ...validPayload(),
          delivery: { pullRequest: true },
          events: {
            ...validEvents(),
            authTokenFile: authTokenFilePath,
          },
        })
      );

      const exitCode = await runRunnerJob({
        payloadFile,
        fetch: fetchMock,
        pipelineRunner: vi.fn(() => runtimeResult("FAIL")),
        prepareWorkspace: vi.fn(async () => ({
          env: { PIPELINE_TARGET_PATH: dir },
          worktreePath: dir,
        })),
        deliverGitBranch,
        createPullRequest,
        stderr: io.stderr,
        stdout: io.stdout,
      });

      expect(exitCode).toBe(1);
      expect(deliverGitBranch).not.toHaveBeenCalled();
      expect(createPullRequest).not.toHaveBeenCalled();
      expect(io.stdoutText()).toBe("");
      expect(io.stderrText()).toMatch(RUNTIME_FAILURE_DETAILS_RE);

      const postedEvents = postedBodies.flatMap((postedBody) => {
        const body = JSON.parse(postedBody) as {
          events: Array<{ log?: { message: string; output?: unknown } }>;
        };
        return body.events;
      });
      expect(JSON.stringify(postedEvents)).not.toContain(
        "runner delivery failed after runtime failure"
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
    const io = ioBuffers();

    try {
      await writeTestSkills(dir);
      await writeIgnoredRepoLocalSmokeConfig(dir);

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
        stdout: io.stdout,
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
      const postedEvents = fetchMock.mock.calls.flatMap((call) => {
        const body = JSON.parse(
          String((call as unknown as [string, RequestInit])[1].body)
        ) as { events: Record<string, unknown>[] };
        return body.events;
      });
      expect(postedEvents).toContainEqual(
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

  it("emits a failed startup phase when workspace preparation fails before runtime starts", async () => {
    const { runRunnerJob } = await loadRunnerModule();
    const io = ioBuffers();
    const fetchMock = vi.fn(async () => okResponse());

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        env,
        payloadFile,
        fetch: fetchMock,
        prepareWorkspace: vi.fn(() =>
          Promise.reject(new Error("workspace clone failed"))
        ),
        stderr: io.stderr,
      });

      expect(exitCode).toBe(70);
      expect(io.stderrText()).toMatch(WORKSPACE_CLONE_FAILURE_RE);
      const postedEvents = fetchMock.mock.calls.flatMap((call) => {
        const body = JSON.parse(
          String((call as unknown as [string, RequestInit])[1].body)
        ) as { events: Record<string, unknown>[] };
        return body.events;
      });
      expect(postedEvents).toEqual([
        expect.objectContaining({
          log: expect.objectContaining({
            level: "info",
            message: "runner startup failed",
            output: {
              error: "workspace clone failed",
              phase: "runner.startup.failed",
              status: "failed",
            },
          }),
          type: "runner.job.phase",
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

  it("exposes runner devspace readiness with a required package config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pipe-runner-readiness-types-"));
    try {
      await writeFile(
        join(dir, "usage.ts"),
        `
import { assertRunnerDevspaceReady, type RunnerDevspaceReadiness } from "${join(
          process.cwd(),
          "src",
          "runner-job",
          "devspace.ts"
        )}";

const readiness: RunnerDevspaceReadiness =
  assertRunnerDevspaceReady("/tmp/package-config-owned");

readiness.config.default_workflow;
`,
        "utf8"
      );
      await writeFile(
        join(dir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              allowImportingTsExtensions: true,
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
              strict: true,
              target: "ES2022",
              typeRoots: [join(process.cwd(), "node_modules", "@types")],
              types: ["node"],
            },
            include: ["usage.ts"],
          },
          null,
          2
        )
      );

      runTypecheck(["--noEmit", "-p", "tsconfig.json"], { cwd: dir });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 30_000);

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
    let fetchCallCount = 0;
    const fetchMock = vi.fn(() => {
      fetchCallCount += 1;
      return fetchCallCount <= 4
        ? Promise.resolve(okResponse())
        : Promise.reject(new Error("console unavailable"));
    });

    await withPayloadContext(async ({ env, payloadFile }) => {
      const exitCode = await runRunnerJob({
        cwd: process.cwd(),
        env,
        payloadFile,
        fetch: fetchMock,
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
                timeout_ms: 900_000,
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
