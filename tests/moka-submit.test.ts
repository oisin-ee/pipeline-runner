import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  SubmitRunnerArgoWorkflowOptions,
  SubmitRunnerArgoWorkflowResult,
} from "../src/argo-submit";
import { buildCommandScheduleYaml } from "../src/argo-submit";
import { loadPipelineConfig, parsePipelineConfigParts } from "../src/config";
import {
  type MokaSubmitInput,
  mokaSubmitOptionsSchema,
  submitMoka,
} from "../src/moka-submit";
import {
  type PipelineRuntimeEvent,
  runPipelineFromConfig,
} from "../src/pipeline-runtime";
import type { RunnerLaunchPlan } from "../src/runner";

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

type CapturedSubmitOptions = Omit<
  SubmitRunnerArgoWorkflowOptions,
  "namespace"
> & {
  namespace?: string;
};
type SubmitMokaDependencies = NonNullable<Parameters<typeof submitMoka>[1]>;

afterAll(() => {
  rmSync(PROJECT_ROOT, { force: true, recursive: true });
});

function captureSubmitCall(calls: CapturedSubmitOptions[]) {
  return (
    input: CapturedSubmitOptions
  ): Promise<SubmitRunnerArgoWorkflowResult> => {
    calls.push(input);
    return Promise.resolve({
      namespace: input.namespace ?? "test-runners",
      payloadConfigMapName: "payload",
      scheduleConfigMapName: "schedule",
      taskDescriptorConfigMapName: "tasks",
      workflowName: "wf",
    });
  };
}

function mokaCommandInput(
  overrides: Partial<
    Omit<
      MokaSubmitInput,
      "commandArgv" | "config" | "eventUrl" | "namespace" | "type"
    >
  > = {}
): MokaSubmitInput {
  return {
    commandArgv: ["opencode", "run", "fix"],
    config: CONFIG,
    eventUrl: "https://console.example/api/pipeline/runner-events",
    ...MANAGED_AUTH,
    namespace: EXPLICIT_NAMESPACE,
    type: "command",
    worktreePath: PROJECT_ROOT,
    ...overrides,
  };
}

function mokaCommandDependencies(
  calls: CapturedSubmitOptions[],
  runId: string,
  resolveGitContext: SubmitMokaDependencies["resolveGitContext"] = () =>
    Promise.resolve(GIT)
): SubmitMokaDependencies {
  return {
    generateRunId: () => runId,
    resolveGitContext,
    submitWorkflow: captureSubmitCall(calls),
  };
}

function submittedRepositoryUrl(calls: CapturedSubmitOptions[]): string {
  if (calls.length !== 1) {
    throw new Error(
      `Expected one workflow submission, received ${calls.length}`
    );
  }
  const payload = JSON.parse(calls[0].payloadJson);
  return payload.repository.url;
}

const MANAGED_AUTH = {
  eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
  eventAuthSecretName: "event-auth-secret",
  gitCredentialsSecretName: "git-credentials-secret",
  githubAuthSecretName: "github-auth-secret",
};

const MANAGED_EVENT_AUTH_TOKEN_FILE =
  "/etc/pipeline/event-auth/EVENT_AUTH_TOKEN_KEY";
const EXPLICIT_NAMESPACE = "test-runners";
const MISSING_GIT_CREDENTIALS_RE = /gitCredentialsSecretName is required/u;
const EXPLICIT_EVENT_SINK = {
  authTokenFile: "/var/run/pipeline/events/token",
  url: "https://console.example/api/pipeline/runner-events",
};
const EVENT_TRANSPORT_CONFLICT_RE = /Choose either eventSink or events/u;

function runtimeConfig() {
  return parsePipelineConfigParts({
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
  });
}

function executor(_plan: RunnerLaunchPlan) {
  return { exitCode: 0, stdout: "ok" };
}

describe("submitMoka", () => {
  it("submits a full graph by generating an execute schedule", async () => {
    const generatedSchedulePath = ".pipeline/runs/run-1/schedule.yaml";
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
        generateSchedule: (input) => {
          expect(input.entrypointId).toBe("execute");
          expect(input.task).toBe("build the feature");
          return Promise.resolve({
            artifact: {
              generated_at: "2026-06-10T00:00:00.000Z",
              kind: "pipeline-schedule",
              root_workflow: "root",
              schedule_id: "run-1",
              source_entrypoint: "execute",
              task: "build the feature",
              version: 1,
              workflows: { root: { nodes: [] } },
            },
            path: generatedSchedulePath,
          });
        },
        readFile: (path) => {
          expect(path).toBe(join(PROJECT_ROOT, generatedSchedulePath));
          return buildCommandScheduleYaml({
            command: ["true"],
            generatedAt: new Date("2026-06-10T00:00:00.000Z"),
            scheduleId: "run-1",
            task: "build the feature",
          });
        },
        resolveGitContext: () => Promise.resolve(GIT),
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].payloadJson);
    expect(calls[0]).toMatchObject({
      generateName: "moka-full-",
      scheduleYaml: expect.stringContaining("kind: pipeline-schedule"),
    });
    expect(calls[0]).toMatchObject(MANAGED_AUTH);
    expect(payload).toMatchObject({
      events: { authTokenFile: MANAGED_EVENT_AUTH_TOKEN_FILE },
      submission: { kind: "graph", mode: "full" },
      workflow: { id: "schedule-run-1-root" },
    });
  });

  it("submits a quick graph with a provided schedule", async () => {
    const schedulePath = join(PROJECT_ROOT, "quick.yaml");
    writeFileSync(
      schedulePath,
      buildCommandScheduleYaml({
        command: ["true"],
        generatedAt: new Date("2026-06-10T00:00:00.000Z"),
        scheduleId: "run-quick",
        task: "fix this",
      })
    );
    const calls: CapturedSubmitOptions[] = [];

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
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-quick",
        resolveGitContext: () => Promise.resolve(GIT),
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].payloadJson);
    expect(calls[0]).toMatchObject({
      generateName: "moka-quick-",
      scheduleYaml: expect.stringContaining("kind: pipeline-schedule"),
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
    const payload = JSON.parse(calls[0].payloadJson);
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

  it("rejects submit input without an event destination", () => {
    const parsed = mokaSubmitOptionsSchema.safeParse({
      commandArgv: ["opencode", "run", "fix"],
      type: "command",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
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
    const payload = JSON.parse(calls[0].payloadJson);
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
      mokaCommandDependencies(calls, "run-github-ssh", () =>
        Promise.resolve({
          ...GIT,
          url: "git@github.com:oisin-ee/tova.git",
        })
      )
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
        commandArgv: ["opencode", "run", "fix"],
        config: CONFIG,
        eventUrl: "https://console.example/api/pipeline/runner-events",
        eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
        eventAuthSecretName: "event-auth-secret",
        gitCredentialsSecretName: "flux-style-git-auth",
        namespace: EXPLICIT_NAMESPACE,
        type: "command",
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-git-credentials-secret",
        resolveGitContext: () => Promise.resolve(GIT),
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
          commandArgv: ["opencode", "run", "fix"],
          config: CONFIG,
          eventUrl: "https://console.example/api/pipeline/runner-events",
          eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
          eventAuthSecretName: "event-auth-secret",
          githubAuthSecretName: "github-auth-secret",
          namespace: EXPLICIT_NAMESPACE,
          type: "command",
          worktreePath: PROJECT_ROOT,
        },
        {
          generateRunId: () => "run-unsupported-ssh",
          resolveGitContext: () =>
            Promise.resolve({
              ...GIT,
              url: "https://github.com/oisin-ee/tova.git",
            }),
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
      task: "PIPE-56 Expose typed Zod moka submit API for Pipeline Console",
    });

    await submitMoka(
      {
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
          title: "Expose typed Zod moka submit API for Pipeline Console",
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
      scheduleYaml,
    });
    const payload = JSON.parse(calls[0].payloadJson);
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
        title: "Expose typed Zod moka submit API for Pipeline Console",
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
        config: runtimeConfig(),
        eventSink: EXPLICIT_EVENT_SINK,
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
        gitCredentialsSecretName: "console-git-credentials",
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
      reporter: (event) => events.push(event),
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
        config: runtimeConfig(),
        eventSink: EXPLICIT_EVENT_SINK,
        hooks: {
          "workflow.start": {
            command: ["node", "-e", "process.exit(0)"],
            failure: "fail",
            kind: "command",
            trusted: true,
          },
        },
        gitCredentialsSecretName: "console-git-credentials",
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
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
`,
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
    });
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        commandArgv: ["true"],
        config,
        eventSink: EXPLICIT_EVENT_SINK,
        hooks: {
          "node.finish": {
            command: ["true"],
            kind: "command",
          },
        },
        gitCredentialsSecretName: "console-git-credentials",
        repository: {
          baseBranch: "main",
          sha: "fedcba9876543210fedcba9876543210fedcba98",
          url: "https://github.com/oisin-ee/pipeline-runner.git",
        },
        run: {
          id: "run-preserve-hooks",
          project: "pipeline-console",
        },
        namespace: EXPLICIT_NAMESPACE,
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
      profiles: `
version: 1
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: Orchestrate }
`,
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
    });

    expect(() =>
      submitMoka({
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
    ).toThrow("Moka submit hook id already exists in config");
  });

  it("rejects submit input that mixes legacy events with eventSink", () => {
    const parsed = mokaSubmitOptionsSchema.safeParse({
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

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(
      EVENT_TRANSPORT_CONFLICT_RE
    );
  });

  it("rejects unsupported direct hook events", () => {
    const parsed = mokaSubmitOptionsSchema.safeParse({
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

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["hooks", "node.nope"]);
  });

  it("rejects invalid public submit inputs with the exported Zod schema", () => {
    const parsed = mokaSubmitOptionsSchema.safeParse({
      mode: "full",
      eventSink: EXPLICIT_EVENT_SINK,
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

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["repository", "url"]);
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
    const payload = JSON.parse(calls[0].payloadJson);
    // runner payload carries the workflow id so the runner can match schedule
    expect(payload).toMatchObject({
      submission: { kind: "graph", mode: "full" },
      workflow: { id: "schedule-run-agent-graph-root" },
    });
    // schedule YAML is passed through — runner loads agent context from it
    expect(calls[0].scheduleYaml).toBe(agentScheduleYaml);
    expect(calls[0].generateName).toBe("moka-full-");
  });

  it("sets delivery.pull_request.enabled on the config passed to generateSchedule when delivery.pullRequest is true", async () => {
    const capturedConfigs: (typeof CONFIG)[] = [];
    const generatedSchedulePath = ".pipeline/runs/run-delivery/schedule.yaml";
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
        generateSchedule: (input) => {
          capturedConfigs.push(input.config);
          return Promise.resolve({
            artifact: {
              generated_at: "2026-06-18T00:00:00.000Z",
              kind: "pipeline-schedule",
              root_workflow: "root",
              schedule_id: "run-delivery",
              source_entrypoint: "execute",
              task: "deliver feature",
              version: 1,
              workflows: { root: { nodes: [] } },
            },
            path: generatedSchedulePath,
          });
        },
        readFile: () =>
          buildCommandScheduleYaml({
            command: ["true"],
            generatedAt: new Date("2026-06-18T00:00:00.000Z"),
            scheduleId: "run-delivery",
            task: "deliver feature",
          }),
        resolveGitContext: () => Promise.resolve(GIT),
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0].delivery?.pull_request?.enabled).toBe(true);
  });
});
