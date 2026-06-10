import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  SubmitRunnerArgoWorkflowOptions,
  SubmitRunnerArgoWorkflowResult,
} from "../src/argo-submit";
import { buildCommandScheduleYaml } from "../src/argo-submit";
import { loadPipelineConfig } from "../src/config";
import { submitMoka } from "../src/moka-submit";

const PROJECT_ROOT = mkdtempSync(join(tmpdir(), "moka-submit-"));
const CONFIG = loadPipelineConfig(PROJECT_ROOT);
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
    expect(payload).toMatchObject({
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
    expect(payload).toMatchObject({
      submission: { kind: "graph", mode: "quick" },
      workflow: { id: "schedule-run-quick-root" },
    });
  });

  it("submits explicit argv as command mode", async () => {
    const calls: CapturedSubmitOptions[] = [];

    await submitMoka(
      {
        commandArgv: ["codex", "-p", "fix"],
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
    expect(payload).toMatchObject({
      submission: { argv: ["codex", "-p", "fix"], kind: "command" },
      workflow: { id: "schedule-run-command-root" },
    });
  });
});
