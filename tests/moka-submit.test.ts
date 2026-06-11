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
import { mokaSubmitOptionsSchema, submitMoka } from "../src/moka-submit";
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

type CapturedSubmitOptions = SubmitRunnerArgoWorkflowOptions;

afterAll(() => {
  rmSync(PROJECT_ROOT, { force: true, recursive: true });
});

function captureSubmitCall(calls: CapturedSubmitOptions[]) {
  return (
    input: CapturedSubmitOptions
  ): Promise<SubmitRunnerArgoWorkflowResult> => {
    calls.push(input);
    return Promise.resolve({
      namespace: input.namespace ?? "momokaya-pipeline",
      payloadConfigMapName: "payload",
      scheduleConfigMapName: "schedule",
      taskDescriptorConfigMapName: "tasks",
      workflowName: "wf",
    });
  };
}

const MOMOKAYA_MANAGED_AUTH = {
  eventAuthSecretKey: "OISIN_PIPELINE_EVENT_AUTH_TOKEN",
  eventAuthSecretName: "pipeline-runner-event-auth",
  githubAuthSecretName: "oisin-bot-github-auth",
  opencodeAuthSecretName: "opencode-auth-1",
};

const MOMOKAYA_EVENT_AUTH_TOKEN_FILE =
  "/etc/pipeline/event-auth/OISIN_PIPELINE_EVENT_AUTH_TOKEN";
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
    expect(calls[0]).toMatchObject(MOMOKAYA_MANAGED_AUTH);
    expect(payload).toMatchObject({
      events: { authTokenFile: MOMOKAYA_EVENT_AUTH_TOKEN_FILE },
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
    expect(calls[0]).toMatchObject(MOMOKAYA_MANAGED_AUTH);
    expect(payload).toMatchObject({
      events: { authTokenFile: MOMOKAYA_EVENT_AUTH_TOKEN_FILE },
      submission: { kind: "graph", mode: "quick" },
      workflow: { id: "schedule-run-quick-root" },
    });
  });

  it("submits explicit argv as command mode", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        commandArgv: ["opencode", "run", "fix"],
        config: CONFIG,
        eventUrl: "https://console.example/api/pipeline/runner-events",
        type: "command",
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-command",
        resolveGitContext: () => Promise.resolve(GIT),
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].payloadJson);
    expect(calls[0]).toMatchObject({
      generateName: "moka-command-",
      scheduleYaml: expect.stringContaining("kind: pipeline-schedule"),
    });
    expect(calls[0]).toMatchObject(MOMOKAYA_MANAGED_AUTH);
    expect(payload).toMatchObject({
      events: { authTokenFile: MOMOKAYA_EVENT_AUTH_TOKEN_FILE },
      submission: { argv: ["opencode", "run", "fix"], kind: "command" },
      workflow: { id: "schedule-run-command-root" },
    });
  });

  it("uses Momokaya production defaults when submit options omit overrides", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        commandArgv: ["opencode", "run", "fix"],
        config: CONFIG,
        type: "command",
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-defaults",
        resolveGitContext: () => Promise.resolve(GIT),
        submitWorkflow: captureSubmitCall(calls),
      }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      eventAuthSecretKey: "OISIN_PIPELINE_EVENT_AUTH_TOKEN",
      imagePullSecretName: "ghcr-pull-secret",
      namespace: "momokaya-pipeline",
      queueName: "momokaya-pipeline",
      serviceAccountName: "pipeline-runner",
    });
    const payload = JSON.parse(calls[0].payloadJson);
    expect(payload).toMatchObject({
      events: {
        authHeader: "Authorization",
        authTokenFile: MOMOKAYA_EVENT_AUTH_TOKEN_FILE,
        url: "https://pipeline-console.momokaya.ee/api/pipeline/runner-events",
      },
      submission: { argv: ["opencode", "run", "fix"], kind: "command" },
      workflow: { id: "schedule-run-defaults-root" },
    });
  });

  it("preserves an explicit custom event URL in the runner payload", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        commandArgv: ["opencode", "run", "fix"],
        config: CONFIG,
        eventUrl: "https://console.example/api/pipeline/runner-events",
        type: "command",
        worktreePath: PROJECT_ROOT,
      },
      {
        generateRunId: () => "run-custom-url",
        resolveGitContext: () => Promise.resolve(GIT),
        submitWorkflow: captureSubmitCall(calls),
      }
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
        opencodeAuthSecretName: "console-opencode-auth",
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
      githubAuthSecretName: "console-github-auth",
      imagePullSecretName: "console-pull-secret",
      namespace: "console-runners",
      opencodeAuthSecretName: "console-opencode-auth",
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
        hooks: {
          "workflow.start": {
            command: ["node", "-e", "process.exit(0)"],
            failure: "fail",
            kind: "command",
            trusted: true,
          },
        },
        mode: "quick",
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
        hooks: {
          "node.finish": {
            command: ["true"],
            kind: "command",
          },
        },
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
        hooks: {
          "node.finish": {
            command: ["true"],
            kind: "command",
          },
        },
        type: "command",
      })
    ).toThrow("Moka submit hook id already exists in config");
  });

  it("rejects submit input that mixes legacy events with eventSink", () => {
    const parsed = mokaSubmitOptionsSchema.safeParse({
      commandArgv: ["true"],
      eventSink: {
        url: "https://console.example/api/pipeline/runner-events",
      },
      events: {
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
});
