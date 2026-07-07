import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "@effect/vitest";

import type { SubmitRunnerArgoWorkflowResult } from "../src/argo-submit";
import { buildCommandScheduleYaml } from "../src/argo-submit";
import { loadPipelineConfig, parsePipelineConfigParts } from "../src/config";
import { mokaSubmitOptionsSchema, submitMoka } from "../src/moka-submit";
import type { MokaSubmitInput } from "../src/moka-submit";
import { runPipelineFromConfig } from "../src/pipeline-runtime";
import type { PipelineRuntimeEvent } from "../src/pipeline-runtime";
import { parseScheduleArtifact } from "../src/planning/generate";
import type { RunnerLaunchPlan } from "../src/runner";
import { runnerCommandPayloadSchema } from "../src/runner-command-contract";
import { parseJson } from "../src/safe-json";
import type { EffectSchemaParseResult } from "../src/schema-boundary";
import { parseResultWithSchema, parseWithSchema } from "../src/schema-boundary";

const PROJECT_ROOT = mkdtempSync(join(tmpdir(), "moka-submit-"));
const CONFIG = loadPipelineConfig(PROJECT_ROOT, {
  allowMissingLintFileReferences: true,
});
const GIT = {
  baseBranch: "main",
  project: "rondo",
  sha: "0123456789abcdef0123456789abcdef01234567",
  url: "https://github.com/oisin-ee/rondo.git",
};

type SubmitMokaDependencies = NonNullable<Parameters<typeof submitMoka>[1]>;
type CapturedSubmitOptions = Parameters<
  NonNullable<SubmitMokaDependencies["submitWorkflow"]>
>[0];

const submittedPayload = (calls: CapturedSubmitOptions[]) => {
  if (calls.length !== 1) {
    throw new Error(
      `Expected one workflow submission, received ${calls.length}`
    );
  }
  return parseWithSchema(
    runnerCommandPayloadSchema,
    parseJson(calls[0].payloadJson, "submitted runner payload")
  );
};

const parseFailureMessage = <T>(parsed: EffectSchemaParseResult<T>): string => {
  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    throw new TypeError("Expected schema parse failure.");
  }
  return parsed.error.message;
};

afterAll(() => {
  rmSync(PROJECT_ROOT, { force: true, recursive: true });
});

const captureSubmitCall =
  (calls: CapturedSubmitOptions[]) =>
  async (
    input: CapturedSubmitOptions
  ): Promise<SubmitRunnerArgoWorkflowResult> => {
    await Promise.resolve();
    calls.push(input);
    return {
      namespace: input.namespace,
      payloadConfigMapName: "payload",
      scheduleConfigMapName: "schedule",
      taskDescriptorConfigMapName: "tasks",
      workflowName: "wf",
    };
  };

const mokaCommandDependencies = (
  calls: CapturedSubmitOptions[],
  runId: string,
  resolveGitContext: SubmitMokaDependencies["resolveGitContext"] = async () => {
    await Promise.resolve();
    return GIT;
  }
): SubmitMokaDependencies => ({
  generateRunId: () => runId,
  resolveGitContext,
  submitWorkflow: captureSubmitCall(calls),
});

const submittedRepositoryUrl = (calls: CapturedSubmitOptions[]): string => {
  const payload = submittedPayload(calls);
  return payload.repository.url;
};

const submittedScheduleBuiltinCount = (
  calls: CapturedSubmitOptions[],
  builtin: string
): number => {
  if (calls.length !== 1 || calls[0].scheduleYaml === undefined) {
    throw new Error("Expected one workflow submission with schedule YAML");
  }
  const artifact = parseScheduleArtifact(calls[0].scheduleYaml);
  return artifact.workflows[artifact.root_workflow].nodes.filter(
    (node) => node.kind === "builtin" && node.builtin === builtin
  ).length;
};

const MANAGED_AUTH = {
  brokerAuth: {
    secretKey: "api-key",
    secretName: "broker-api-key",
    url: "https://cliproxy.momokaya.ee",
  },
  eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
  eventAuthSecretName: "event-auth-secret",
  gitCredentialsSecretName: "git-credentials-secret",
  githubAuthSecretName: "github-auth-secret",
};

const MANAGED_EVENT_AUTH_TOKEN_FILE =
  "/etc/pipeline/event-auth/EVENT_AUTH_TOKEN_KEY";
const EXPLICIT_NAMESPACE = "test-runners";

const mokaCommandInput = (
  overrides: Partial<
    Omit<
      MokaSubmitInput,
      "commandArgv" | "config" | "eventUrl" | "namespace" | "type"
    >
  > = {}
): MokaSubmitInput => ({
  commandArgv: ["opencode", "run", "fix"],
  config: CONFIG,
  eventUrl: "https://console.example/api/pipeline/runner-events",
  ...MANAGED_AUTH,
  namespace: EXPLICIT_NAMESPACE,
  type: "command",
  worktreePath: PROJECT_ROOT,
  ...overrides,
});
const MISSING_GIT_CREDENTIALS_RE = /gitCredentialsSecretName is required/u;
const EXPLICIT_EVENT_SINK = {
  authTokenFile: "/var/run/pipeline/events/token",
  url: "https://console.example/api/pipeline/runner-events",
};
const EVENT_TRANSPORT_CONFLICT_RE = /Choose either eventSink or events/u;
const REMOTE_SUBMIT_ROOT = join(
  import.meta.dirname,
  "..",
  "src",
  "remote",
  "submit"
);
const REMOTE_SUBMIT_MODULES = [
  "argo-submission.ts",
  "compilation.ts",
  "event-boundary.ts",
  "hook-events.ts",
  "io.ts",
  "service.ts",
] as const;

const makeGitWorktree = (prefix: string): string => {
  const worktreePath = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(worktreePath, "README.md"), "# submit fixture\n");
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: worktreePath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: worktreePath,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: worktreePath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "README.md"], {
    cwd: worktreePath,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "-m", "Initial commit"], {
    cwd: worktreePath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/oisin-ee/rondo.git"],
    {
      cwd: worktreePath,
      stdio: "ignore",
    }
  );
  return worktreePath;
};

const runtimeConfig = () =>
  parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: direct-hooks
orchestrator:
  profile: orchestrator
workflows:
  direct-hooks:
    nodes:
      - id: a
        kind: agent
        profile: a
`,
    profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
  a:
    runner: opencode
    instructions: { inline: Agent A }
`,
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
  });

const executor = (_plan: RunnerLaunchPlan) => ({ exitCode: 0, stdout: "ok" });

describe("submitMoka", () => {
  it("keeps submit contract, compilation, IO, event/auth, and Argo submission in separate owners", () => {
    for (const fileName of REMOTE_SUBMIT_MODULES) {
      expect(existsSync(join(REMOTE_SUBMIT_ROOT, fileName))).toBe(true);
    }

    const publicSource = readFileSync(
      join(import.meta.dirname, "..", "src", "moka-submit.ts"),
      "utf-8"
    );
    const compilationSource = readFileSync(
      join(REMOTE_SUBMIT_ROOT, "compilation.ts"),
      "utf-8"
    );
    const eventBoundarySource = readFileSync(
      join(REMOTE_SUBMIT_ROOT, "event-boundary.ts"),
      "utf-8"
    );
    const ioSource = readFileSync(join(REMOTE_SUBMIT_ROOT, "io.ts"), "utf-8");
    const argoSubmissionSource = readFileSync(
      join(REMOTE_SUBMIT_ROOT, "argo-submission.ts"),
      "utf-8"
    );

    expect(publicSource).not.toContain("simple-git");
    expect(publicSource).not.toContain("buildRunnerCommandPayload");
    expect(publicSource).not.toContain("eventAuthSecretKey is required");
    expect(publicSource).toContain("mokaSubmitOptionsSchema");
    expect(compilationSource).toContain("compileMokaSubmitPlan");
    expect(eventBoundarySource).toContain("runnerEvents");
    expect(eventBoundarySource).toContain("configWithSubmitHooks");
    expect(ioSource).toContain("resolveSubmissionContext");
    expect(argoSubmissionSource).toContain("submitRunnerArgoWorkflow");
  });

  it("submits a full graph as a dynamic DB-drained workflow without generating a local schedule", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        config: CONFIG,
        eventUrl: "https://console.example/api/pipeline/runner-events",
        mode: "full",
        ...MANAGED_AUTH,
        namespace: EXPLICIT_NAMESPACE,
        task: "build the feature",
        type: "graph",
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-1",
        generateSchedule: () => {
          throw new Error(
            "generated graph schedules are created in runner pods"
          );
        },
        readFile: () => {
          throw new Error("generated schedule should be returned in memory");
        },
        resolveGitContext: async () => {
          await Promise.resolve();
          return GIT;
        },
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    const payload = submittedPayload(calls);
    expect(calls[0]).toMatchObject({
      generateName: "moka-full-",
      workflowId: "schedule-run-1-root",
    });
    expect(calls[0]).not.toHaveProperty("scheduleYaml");
    expect(calls[0]).toMatchObject(MANAGED_AUTH);
    expect(payload).toMatchObject({
      events: { authTokenFile: MANAGED_EVENT_AUTH_TOKEN_FILE },
      submission: { kind: "graph", mode: "full" },
      workflow: { id: "schedule-run-1-root" },
    });
  });

  it("keeps generated graph schedule YAML out of the submit client filesystem", async () => {
    const worktreePath = makeGitWorktree("moka-submit-generated-");
    const calls: CapturedSubmitOptions[] = [];

    try {
      await submitMoka(
        {
          config: CONFIG,
          eventUrl: "https://console.example/api/pipeline/runner-events",
          mode: "quick",
          ...MANAGED_AUTH,
          namespace: EXPLICIT_NAMESPACE,
          task: "fix this",
          type: "graph",
          worktreePath,
        },
        {
          generateRunId: () => "run-generated-memory",
          generateSchedule: () => {
            throw new Error(
              "generated graph schedules are created in runner pods"
            );
          },
          submitWorkflow: captureSubmitCall(calls),
        }
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].scheduleYaml).toBeUndefined();
      expect(calls[0].workflowId).toBe("schedule-run-generated-memory-root");
      expect(existsSync(join(worktreePath, ".pipeline"))).toBe(false);
    } finally {
      rmSync(worktreePath, { force: true, recursive: true });
    }
  });

  it("submits a quick graph with a provided schedule", async () => {
    const worktreePath = makeGitWorktree("moka-submit-explicit-schedule-");
    const schedulePath = join(worktreePath, "quick.yaml");
    const scheduleYaml = buildCommandScheduleYaml({
      command: ["true"],
      generatedAt: new Date("2026-06-10T00:00:00.000Z"),
      scheduleId: "run-quick",
      task: "fix this",
    });
    writeFileSync(schedulePath, scheduleYaml);
    const calls: CapturedSubmitOptions[] = [];

    try {
      await submitMoka(
        {
          config: CONFIG,
          eventUrl: "https://console.example/api/pipeline/runner-events",
          mode: "quick",
          ...MANAGED_AUTH,
          namespace: EXPLICIT_NAMESPACE,
          schedulePath,
          task: "fix this",
          type: "graph",
          worktreePath,
        },
        {
          generateRunId: () => "run-quick",
          generateSchedule: () => {
            throw new Error("explicit schedule path uses file input");
          },
          submitWorkflow: captureSubmitCall(calls),
        }
      );
    } finally {
      rmSync(worktreePath, { force: true, recursive: true });
    }

    expect(calls).toHaveLength(1);
    const payload = submittedPayload(calls);
    expect(calls[0]).toMatchObject({
      generateName: "moka-quick-",
      scheduleYaml,
    });
    expect(calls[0]).toMatchObject(MANAGED_AUTH);
    expect(payload).toMatchObject({
      events: { authTokenFile: MANAGED_EVENT_AUTH_TOKEN_FILE },
      submission: { kind: "graph", mode: "quick" },
      workflow: { id: "schedule-run-quick-root" },
    });
  });

  it("submits explicit argv as command mode", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      mokaCommandInput(),
      mokaCommandDependencies(calls, "run-command")
    );

    expect(calls).toHaveLength(1);
    const payload = submittedPayload(calls);
    expect(calls[0]).toMatchObject({
      generateName: "moka-command-",
      scheduleYaml: expect.stringContaining("kind: pipeline-schedule"),
    });
    expect(calls[0]).toMatchObject(MANAGED_AUTH);
    expect(payload).toMatchObject({
      events: { authTokenFile: MANAGED_EVENT_AUTH_TOKEN_FILE },
      submission: { argv: ["opencode", "run", "fix"], kind: "command" },
      workflow: { id: "schedule-run-command-root" },
    });
  });

  it("forwards caller-supplied Workflow retention, deadline, and pod GC fields", async () => {
    const calls: CapturedSubmitOptions[] = [];
    const {
      config: _config,
      worktreePath: _worktreePath,
      ...schemaInput
    } = mokaCommandInput({
      activeDeadlineSeconds: 3600,
      podGC: {
        deleteDelayDuration: "30s",
        strategy: "OnPodSuccess",
      },
      ttlStrategy: {
        secondsAfterFailure: 604_800,
        secondsAfterSuccess: 300,
      },
    });

    const parsed = parseWithSchema(mokaSubmitOptionsSchema, schemaInput);

    expect(parsed).toMatchObject({
      activeDeadlineSeconds: 3600,
      podGC: {
        deleteDelayDuration: "30s",
        strategy: "OnPodSuccess",
      },
      ttlStrategy: {
        secondsAfterFailure: 604_800,
        secondsAfterSuccess: 300,
      },
    });

    await submitMoka(
      mokaCommandInput({
        activeDeadlineSeconds: 3600,
        podGC: {
          deleteDelayDuration: "30s",
          strategy: "OnPodSuccess",
        },
        ttlStrategy: {
          secondsAfterFailure: 604_800,
          secondsAfterSuccess: 300,
        },
      }),
      mokaCommandDependencies(calls, "run-lifecycle")
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      activeDeadlineSeconds: 3600,
      podGC: {
        deleteDelayDuration: "30s",
        strategy: "OnPodSuccess",
      },
      ttlStrategy: {
        secondsAfterFailure: 604_800,
        secondsAfterSuccess: 300,
      },
    });
  });

  it("rejects submit input without an event destination", () => {
    const parsed = parseResultWithSchema(mokaSubmitOptionsSchema, {
      brokerAuth: MANAGED_AUTH.brokerAuth,
      commandArgv: ["opencode", "run", "fix"],
      type: "command",
    });

    expect(parseFailureMessage(parsed)).toContain(
      "eventUrl is required unless eventSink or events is provided"
    );
  });

  it("preserves an explicit custom event URL in the runner payload", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      mokaCommandInput(),
      mokaCommandDependencies(calls, "run-custom-url")
    );

    expect(calls).toHaveLength(1);
    const payload = submittedPayload(calls);
    expect(payload).toMatchObject({
      events: {
        url: "https://console.example/api/pipeline/runner-events",
      },
      submission: { argv: ["opencode", "run", "fix"], kind: "command" },
      workflow: { id: "schedule-run-custom-url-root" },
    });
  });

  it("normalizes resolved GitHub SSH remotes to HTTPS for runner payloads", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      mokaCommandInput(),
      mokaCommandDependencies(calls, "run-github-ssh", async () => {
        await Promise.resolve();
        return {
          ...GIT,
          url: "git@github.com:oisin-ee/tova.git",
        };
      })
    );

    expect(submittedRepositoryUrl(calls)).toBe(
      "https://github.com/oisin-ee/tova.git"
    );
  });

  it("normalizes explicit GitHub SSH repository URLs to HTTPS for runner payloads", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      mokaCommandInput({
        repository: {
          baseBranch: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          url: "ssh://git@github.com/oisin-ee/tova.git",
        },
        run: {
          id: "run-explicit-ssh",
          project: "tova",
        },
      }),
      mokaCommandDependencies(calls, "run-explicit-ssh", () => {
        throw new Error(
          "local git should not be resolved for explicit context"
        );
      })
    );

    expect(submittedRepositoryUrl(calls)).toBe(
      "https://github.com/oisin-ee/tova.git"
    );
  });

  it("rejects non-GitHub SSH repository URLs before workflow submission", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await expect(
      submitMoka(
        mokaCommandInput({
          repository: {
            baseBranch: "main",
            sha: "0123456789abcdef0123456789abcdef01234567",
            url: "git@gitlab.com:oisin-ee/tova.git",
          },
          run: {
            id: "run-unsupported-ssh",
            project: "tova",
          },
        }),
        mokaCommandDependencies(calls, "run-unsupported-ssh", () => {
          throw new Error(
            "local git should not be resolved for explicit context"
          );
        })
      )
    ).rejects.toThrow(
      "SSH git remote git@gitlab.com:oisin-ee/tova.git is not supported for moka submit; use an HTTPS GitHub remote"
    );
    expect(calls).toHaveLength(0);
  });

  it("passes the standard git credentials Secret to workflow submission", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        brokerAuth: MANAGED_AUTH.brokerAuth,
        commandArgv: ["opencode", "run", "fix"],
        config: CONFIG,
        eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
        eventAuthSecretName: "event-auth-secret",
        eventUrl: "https://console.example/api/pipeline/runner-events",
        gitCredentialsSecretName: "flux-style-git-auth",
        namespace: EXPLICIT_NAMESPACE,
        type: "command",
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-git-credentials-secret",
        resolveGitContext: async () => {
          await Promise.resolve();
          return GIT;
        },
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].gitCredentialsSecretName).toBe("flux-style-git-auth");
  });

  it("rejects runner submissions without a git credentials Secret", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await expect(
      submitMoka(
        {
          brokerAuth: MANAGED_AUTH.brokerAuth,
          commandArgv: ["opencode", "run", "fix"],
          config: CONFIG,
          eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
          eventAuthSecretName: "event-auth-secret",
          eventUrl: "https://console.example/api/pipeline/runner-events",
          githubAuthSecretName: "github-auth-secret",
          namespace: EXPLICIT_NAMESPACE,
          type: "command",
          worktreePath: PROJECT_ROOT,
        },
        {
          generateRunId: () => "run-unsupported-ssh",
          resolveGitContext: async () => {
            await Promise.resolve();
            return {
              ...GIT,
              url: "https://github.com/oisin-ee/tova.git",
            };
          },
          submitWorkflow: captureSubmitCall(calls),
        }
      )
    ).rejects.toThrow(MISSING_GIT_CREDENTIALS_RE);
    expect(calls).toHaveLength(0);
  });

  it("submits a Console-provided ticket task without resolving local git", async () => {
    const calls: CapturedSubmitOptions[] = [];
    const scheduleYaml = buildCommandScheduleYaml({
      command: ["true"],
      generatedAt: new Date("2026-06-10T00:00:00.000Z"),
      scheduleId: "run-console",
      task: "PIPE-56 Expose typed Effect Schema moka submit API for Pipeline Console",
    });

    await submitMoka(
      {
        brokerAuth: MANAGED_AUTH.brokerAuth,
        config: CONFIG,
        delivery: { pullRequest: true },
        eventAuthSecretKey: "CONSOLE_EVENT_TOKEN",
        eventAuthSecretName: "console-event-auth",
        eventSink: {
          authHeader: "X-Pipeline-Event-Token",
          authTokenFile: "/var/run/pipeline/events/token",
          url: "https://console.example/api/pipeline/runner-events",
        },
        gitCredentialsSecretName: "console-git-credentials",
        githubAuthSecretName: "console-github-auth",
        hookPolicy: {
          allowCommandHooks: false,
        },
        hooks: {
          "node.finish": {
            command: ["node", "scripts/report-node-finish.mjs"],
            failure: "fail",
            input: { source: "pipeline-console" },
            kind: "command",
            publishResult: true,
            timeoutMs: 5000,
            trusted: true,
          },
        },
        imagePullSecretName: "console-pull-secret",
        mode: "quick",
        namespace: "console-runners",
        repository: {
          baseBranch: "main",
          sha: "fedcba9876543210fedcba9876543210fedcba98",
          url: "https://github.com/oisin-ee/pipeline-runner.git",
        },
        run: {
          id: "run-console",
          project: "pipeline-console",
          requestedBy: "console-user@example.com",
        },
        scheduleYaml,
        task: {
          id: "PIPE-56",
          kind: "ticket",
          path: "backlog/tasks/pipe-56.md",
          title:
            "Expose typed Effect Schema moka submit API for Pipeline Console",
        },
        type: "graph",
      },
      {
        resolveGitContext: () => {
          throw new Error("local git should not be resolved for Console input");
        },
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      eventAuthSecretKey: "CONSOLE_EVENT_TOKEN",
      eventAuthSecretName: "console-event-auth",
      generateName: "moka-quick-",
      gitCredentialsSecretName: "console-git-credentials",
      githubAuthSecretName: "console-github-auth",
      imagePullSecretName: "console-pull-secret",
      namespace: "console-runners",
    });
    expect(calls[0].scheduleYaml).not.toBe(scheduleYaml);
    expect(submittedScheduleBuiltinCount(calls, "open-pull-request")).toBe(1);
    const payload = submittedPayload(calls);
    expect(payload).toMatchObject({
      delivery: { pullRequest: true },
      events: {
        authHeader: "X-Pipeline-Event-Token",
        authTokenFile: "/var/run/pipeline/events/token",
        url: "https://console.example/api/pipeline/runner-events",
      },
      hookPolicy: {
        allowCommandHooks: false,
      },
      repository: {
        baseBranch: "main",
        sha: "fedcba9876543210fedcba9876543210fedcba98",
        url: "https://github.com/oisin-ee/pipeline-runner.git",
      },
      run: {
        id: "run-console",
        project: "pipeline-console",
        requestedBy: "console-user@example.com",
      },
      submission: { kind: "graph", mode: "quick" },
      task: {
        id: "PIPE-56",
        kind: "ticket",
        path: "backlog/tasks/pipe-56.md",
        title:
          "Expose typed Effect Schema moka submit API for Pipeline Console",
      },
      workflow: { id: "schedule-run-console-root" },
    });
    expect(calls[0].config.hooks.functions).toMatchObject({
      "moka-submit-node-finish": {
        command: ["node", "scripts/report-node-finish.mjs"],
        kind: "command",
        timeout_ms: 5000,
        trusted: true,
      },
    });
    expect(calls[0].config.hooks.on["node.finish"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          failure: "fail",
          function: "moka-submit-node-finish",
          id: "moka-submit-node-finish",
          result: { publish: true },
          with: { source: "pipeline-console" },
        }),
      ])
    );
  });

  it("normalizes direct hooks into runtime hook config and emits lifecycle results", async () => {
    const calls: CapturedSubmitOptions[] = [];
    const events: PipelineRuntimeEvent[] = [];
    const publishScript =
      "const fs=require('node:fs');" +
      "fs.writeFileSync(process.env.PIPELINE_HOOK_RESULT," +
      "JSON.stringify({status:'pass',summary:'direct hook published',outputs:{ticket:'PC-43'}}));";

    await submitMoka(
      {
        brokerAuth: MANAGED_AUTH.brokerAuth,
        config: runtimeConfig(),
        eventSink: EXPLICIT_EVENT_SINK,
        gitCredentialsSecretName: "console-git-credentials",
        hooks: {
          "node.finish": {
            command: ["node", "-e", publishScript],
            failure: "fail",
            input: { source: "pipeline-console" },
            kind: "command",
            publishResult: true,
            saveResultAs: "hooks.nodeFinish",
            trusted: true,
            where: { node: "a" },
          },
        },
        mode: "quick",
        namespace: EXPLICIT_NAMESPACE,
        repository: {
          baseBranch: "main",
          sha: "fedcba9876543210fedcba9876543210fedcba98",
          url: "https://github.com/oisin-ee/pipeline-runner.git",
        },
        run: {
          id: "run-direct-hooks",
          project: "pipeline-console",
        },
        scheduleYaml: buildCommandScheduleYaml({
          command: ["true"],
          generatedAt: new Date("2026-06-10T00:00:00.000Z"),
          scheduleId: "run-direct-hooks",
          task: "exercise direct submit hooks",
        }),
        task: "exercise direct submit hooks",
        type: "graph",
      },
      { submitWorkflow: captureSubmitCall(calls) }
    );

    const result = await runPipelineFromConfig({
      config: calls[0].config,
      executor,
      hookPolicy: { allowCommandHooks: true },
      reporter: (event) => {
        events.push(event);
      },
      task: "exercise direct submit hooks",
      workflowId: "direct-hooks",
      worktreePath: PROJECT_ROOT,
    });

    expect(result.outcome).toBe("PASS");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "node.finish",
          functionId: "moka-submit-node-finish",
          hookId: "moka-submit-node-finish",
          nodeId: "a",
          required: true,
          type: "hook.start",
          workflowId: "direct-hooks",
        }),
        expect.objectContaining({
          event: "node.finish",
          hookId: "moka-submit-node-finish",
          nodeId: "a",
          passed: true,
          required: true,
          type: "hook.finish",
          workflowId: "direct-hooks",
        }),
        expect.objectContaining({
          event: "node.finish",
          functionId: "moka-submit-node-finish",
          hookId: "moka-submit-node-finish",
          nodeId: "a",
          outputs: { ticket: "PC-43" },
          status: "pass",
          summary: "direct hook published",
          type: "hook.result",
          workflowId: "direct-hooks",
        }),
      ])
    );
  });

  it("honors direct submit command hook policy during runtime execution", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        brokerAuth: MANAGED_AUTH.brokerAuth,
        config: runtimeConfig(),
        eventSink: EXPLICIT_EVENT_SINK,
        gitCredentialsSecretName: "console-git-credentials",
        hooks: {
          "workflow.start": {
            command: ["node", "-e", "process.exit(0)"],
            failure: "fail",
            kind: "command",
            trusted: true,
          },
        },
        mode: "quick",
        namespace: EXPLICIT_NAMESPACE,
        repository: {
          baseBranch: "main",
          sha: "fedcba9876543210fedcba9876543210fedcba98",
          url: "https://github.com/oisin-ee/pipeline-runner.git",
        },
        run: {
          id: "run-policy",
          project: "pipeline-console",
        },
        scheduleYaml: buildCommandScheduleYaml({
          command: ["true"],
          generatedAt: new Date("2026-06-10T00:00:00.000Z"),
          scheduleId: "run-policy",
          task: "deny direct submit hooks",
        }),
        task: "deny direct submit hooks",
        type: "graph",
      },
      { submitWorkflow: captureSubmitCall(calls) }
    );

    const result = await runPipelineFromConfig({
      config: calls[0].config,
      executor,
      hookPolicy: { allowCommandHooks: false },
      task: "deny direct submit hooks",
      workflowId: "direct-hooks",
      worktreePath: PROJECT_ROOT,
    });

    expect(result.outcome).toBe("FAIL");
    expect(result.hookFailures[0].evidence).toContain(
      "command hooks are disabled"
    );
  });

  it("preserves existing hooks and rejects generated direct hook id conflicts", async () => {
    const config = parsePipelineConfigParts({
      pipeline: `
version: 1
default_workflow: default
hooks:
  functions:
    existing:
      kind: command
      command: ["true"]
  on:
    workflow.start:
      - id: existing
        function: existing
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes: []
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
`,
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
    });
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        brokerAuth: MANAGED_AUTH.brokerAuth,
        commandArgv: ["true"],
        config,
        eventSink: EXPLICIT_EVENT_SINK,
        gitCredentialsSecretName: "console-git-credentials",
        hooks: {
          "node.finish": {
            command: ["true"],
            kind: "command",
          },
        },
        namespace: EXPLICIT_NAMESPACE,
        repository: {
          baseBranch: "main",
          sha: "fedcba9876543210fedcba9876543210fedcba98",
          url: "https://github.com/oisin-ee/pipeline-runner.git",
        },
        run: {
          id: "run-preserve-hooks",
          project: "pipeline-console",
        },
        type: "command",
      },
      { submitWorkflow: captureSubmitCall(calls) }
    );

    expect(calls[0].config.hooks.functions).toMatchObject({
      existing: { command: ["true"], kind: "command" },
      "moka-submit-node-finish": {
        command: ["true"],
        kind: "command",
      },
    });
    expect(calls[0].config.hooks.on["workflow.start"]).toEqual([
      expect.objectContaining({ function: "existing", id: "existing" }),
    ]);

    const conflictingConfig = parsePipelineConfigParts({
      pipeline: `
version: 1
default_workflow: default
hooks:
  functions:
    moka-submit-node-finish:
      kind: command
      command: ["true"]
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes: []
`,
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
`,
      runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
    });

    await expect(
      submitMoka({
        brokerAuth: MANAGED_AUTH.brokerAuth,
        commandArgv: ["true"],
        config: conflictingConfig,
        eventSink: EXPLICIT_EVENT_SINK,
        hooks: {
          "node.finish": {
            command: ["true"],
            kind: "command",
          },
        },
        namespace: EXPLICIT_NAMESPACE,
        type: "command",
      })
    ).rejects.toThrow("Moka submit hook id already exists in config");
  });

  it("rejects submit input that mixes legacy events with eventSink", () => {
    const parsed = parseResultWithSchema(mokaSubmitOptionsSchema, {
      brokerAuth: MANAGED_AUTH.brokerAuth,
      commandArgv: ["true"],
      eventSink: {
        authTokenFile: "/var/run/pipeline/events/token",
        url: "https://console.example/api/pipeline/runner-events",
      },
      events: {
        authTokenFile: "/var/run/pipeline/events/token",
        url: "https://legacy.example/api/pipeline/runner-events",
      },
      type: "command",
    });

    expect(parseFailureMessage(parsed)).toMatch(EVENT_TRANSPORT_CONFLICT_RE);
  });

  it("rejects unsupported direct hook events", () => {
    const parsed = parseResultWithSchema(mokaSubmitOptionsSchema, {
      brokerAuth: MANAGED_AUTH.brokerAuth,
      commandArgv: ["true"],
      eventSink: EXPLICIT_EVENT_SINK,
      hooks: {
        "node.nope": {
          command: ["true"],
          kind: "command",
        },
      },
      type: "command",
    });

    expect(parseFailureMessage(parsed)).toContain("hooks.node.nope");
  });

  it("rejects invalid public submit inputs with the exported Effect schema", () => {
    const parsed = parseResultWithSchema(mokaSubmitOptionsSchema, {
      brokerAuth: MANAGED_AUTH.brokerAuth,
      eventSink: EXPLICIT_EVENT_SINK,
      mode: "full",
      repository: {
        baseBranch: "main",
        url: "not a git URL",
      },
      run: {
        id: "run-invalid",
        project: "pipeline-console",
      },
      task: { kind: "prompt", prompt: "ship it" },
      type: "graph",
    });

    expect(parseFailureMessage(parsed)).toContain("repository.url");
  });

  // PIPE-94.4: AC1 — pre-submit createRun upsert
  it("calls upsertRunRecord with runId and scheduleYaml before Argo submission (AC1)", async () => {
    const calls: CapturedSubmitOptions[] = [];
    type RunRecordCapture =
      | {
          plan: { runId: string; scheduleYaml?: string };
          worktreePath: string;
        }
      | {
          plan: { runId: string; scheduleYaml?: string };
        };
    const runRecords: RunRecordCapture[] = [];

    await submitMoka(mokaCommandInput(), {
      ...mokaCommandDependencies(calls, "run-upsert-create"),
      upsertRunRecord: async (plan, worktreePath) => {
        await Promise.resolve();
        if (worktreePath === undefined) {
          runRecords.push({ plan });
          return;
        }
        runRecords.push({ plan, worktreePath });
      },
    });

    expect(runRecords).toHaveLength(1);
    expect(runRecords[0].plan.runId).toBe("run-upsert-create");
    expect(runRecords[0].plan.scheduleYaml).toContain(
      "kind: pipeline-schedule"
    );
    expect(runRecords[0]).toMatchObject({ worktreePath: PROJECT_ROOT });
    // Argo submission must still complete
    expect(calls).toHaveLength(1);
  });

  // PIPE-94.4: AC2 — guard ensures Argo submission proceeds even when upsert fails
  it("still submits Argo workflow when upsertRunRecord throws (DB unreachable, AC2)", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(mokaCommandInput(), {
      ...mokaCommandDependencies(calls, "run-db-down"),
      upsertRunRecord: async () => {
        await Promise.resolve();
        throw new Error("simulated DB connection refused");
      },
    });

    // Argo workflow submitted despite the upsert failure
    expect(calls).toHaveLength(1);
  });

  it("submits a graph schedule containing agent-kind nodes through the Argo compiler", async () => {
    /*
     * AC#4: mirror a real moka submit graph path with a schedule that contains
     * agent-kind nodes. Confirms the whole submit stack (moka-submit →
     * argo-submit → argo-graph) accepts agent nodes without error and that the
     * runner payload carries the schedule payload so the runner can recover
     * agent context by nodeId.
     */
    const calls: CapturedSubmitOptions[] = [];

    // runtimeConfig() defines profiles: orchestrator and a
    const agentScheduleYaml = `
kind: pipeline-schedule
version: 1
schedule_id: run-agent-graph
generated_at: 2026-06-10T00:00:00.000Z
source_entrypoint: execute
task: Implement feature
root_workflow: root
workflows:
  root:
    nodes:
      - id: plan
        kind: agent
        profile: orchestrator
      - id: impl
        kind: agent
        profile: a
        needs: [plan]
      - id: review
        kind: agent
        profile: orchestrator
        needs: [impl]
`;

    await submitMoka(
      {
        config: runtimeConfig(),
        ...MANAGED_AUTH,
        eventUrl: "https://console.example/api/pipeline/runner-events",
        mode: "full",
        namespace: EXPLICIT_NAMESPACE,
        repository: {
          baseBranch: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
          url: "https://github.com/oisin-ee/rondo.git",
        },
        run: {
          id: "run-agent-graph",
          project: "rondo",
        },
        scheduleYaml: agentScheduleYaml,
        task: "Implement feature",
        type: "graph",
      },
      {
        resolveGitContext: () => {
          throw new Error(
            "local git should not be resolved when context is explicit"
          );
        },
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    const payload = submittedPayload(calls);
    // runner payload carries the workflow id so the runner can match schedule
    expect(payload).toMatchObject({
      submission: { kind: "graph", mode: "full" },
      workflow: { id: "schedule-run-agent-graph-root" },
    });
    // schedule YAML is passed through — runner loads agent context from it
    expect(calls[0].scheduleYaml).toBe(agentScheduleYaml);
    expect(calls[0].generateName).toBe("moka-full-");
  });

  it("keeps pull-request delivery in the dynamic runner payload when delivery.pullRequest is true", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        config: CONFIG,
        delivery: { pullRequest: true },
        eventUrl: "https://console.example/api/pipeline/runner-events",
        mode: "full",
        ...MANAGED_AUTH,
        namespace: EXPLICIT_NAMESPACE,
        task: "deliver feature",
        type: "graph",
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-delivery",
        generateSchedule: () => {
          throw new Error(
            "generated graph schedules are created in runner pods"
          );
        },
        readFile: () => {
          throw new Error("generated schedule should be returned in memory");
        },
        resolveGitContext: async () => {
          await Promise.resolve();
          return GIT;
        },
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    expect(submittedPayload(calls).delivery).toEqual({
      mode: "create-new-pr",
      pullRequest: true,
    });
  });

  it("does not append pull-request delivery to explicit graph schedules when payload delivery is absent or false", async () => {
    const cases: {
      delivery?: MokaSubmitInput["delivery"];
      runId: string;
    }[] = [
      { runId: "run-delivery-absent" },
      { delivery: { pullRequest: false }, runId: "run-delivery-false" },
    ];

    for (const submitCase of cases) {
      const calls: CapturedSubmitOptions[] = [];

      await submitMoka(
        {
          config: CONFIG,
          ...(submitCase.delivery ? { delivery: submitCase.delivery } : {}),
          eventUrl: "https://console.example/api/pipeline/runner-events",
          mode: "full",
          ...MANAGED_AUTH,
          namespace: EXPLICIT_NAMESPACE,
          repository: {
            baseBranch: GIT.baseBranch,
            sha: GIT.sha,
            url: GIT.url,
          },
          run: { id: submitCase.runId, project: "rondo" },
          scheduleYaml: buildCommandScheduleYaml({
            command: ["true"],
            generatedAt: new Date("2026-06-10T00:00:00.000Z"),
            scheduleId: submitCase.runId,
            task: "deliver feature",
          }),
          task: "deliver feature",
          type: "graph",
          worktreePath: PROJECT_ROOT,
        },
        { submitWorkflow: captureSubmitCall(calls) }
      );

      expect(submittedScheduleBuiltinCount(calls, "open-pull-request")).toBe(0);
    }
  });
});
