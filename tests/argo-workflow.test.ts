import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildRunnerArgoWorkflowManifest,
  runnerArgoWorkflowManifestSchema,
  stringifyRunnerArgoWorkflow,
} from "../src/argo-workflow";
import type { PipelineConfig } from "../src/config";
import { loadPipelineConfig } from "../src/config";
import { compileWorkflowPlan } from "../src/workflow-planner";

const DEFAULT_PROJECT = mkdtempSync(join(tmpdir(), "argo-workflow-"));
const DEFAULT_CONFIG = loadPipelineConfig(DEFAULT_PROJECT, {
  allowMissingLintFileReferences: true,
});

afterAll(() => {
  rmSync(DEFAULT_PROJECT, { force: true, recursive: true });
});

function plan() {
  const config: PipelineConfig = structuredClone(DEFAULT_CONFIG);
  config.default_workflow = "argo";
  config.workflows.argo = {
    nodes: [
      { command: ["echo", "one"], id: "one", kind: "command" },
      { command: ["echo", "two"], id: "two", kind: "command", needs: ["one"] },
      {
        command: ["echo", "three"],
        id: "three",
        kind: "command",
        needs: ["one"],
      },
    ],
  };
  return compileWorkflowPlan(config, "argo");
}

const BASE_OPTIONS = {
  generateName: "pipeline-run-",
  namespace: "momokaya-pipeline",
  payloadConfigMapName: "pipeline-payload-run-1",
  scheduleConfigMapName: "pipeline-schedule-run-1",
  taskDescriptorConfigMapName: "pipeline-task-descriptors-run-1",
};

describe("runner Argo Workflow manifest", () => {
  it("returns a Zod-validated Argo Workflow resource", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    expect(runnerArgoWorkflowManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest).toMatchObject({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Workflow",
      metadata: {
        generateName: "pipeline-run-",
        namespace: "momokaya-pipeline",
      },
      spec: {
        entrypoint: "pipeline",
        serviceAccountName: "pipeline-runner",
      },
    });
  });

  it("compiles planner dependencies into Argo DAG task dependencies", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    const dag = manifest.spec.templates.find(
      (template) => template.name === "pipeline"
    )?.dag;

    expect(
      Object.fromEntries(
        (dag?.tasks ?? []).map((task) => [task.name, task.dependencies ?? []])
      )
    ).toEqual({
      "node-one": [],
      "node-three": ["node-one"],
      "node-two": ["node-one"],
    });
  });

  it("passes explicit argv to each runner-command task template", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      eventAuthSecretKey: "OISIN_PIPELINE_EVENT_AUTH_TOKEN",
      eventAuthSecretName: "pipeline-runner-event-auth",
      githubAuthSecretName: "oisin-bot-github-auth",
      imagePullSecretName: "ghcr-pull-secret",
      opencodeAuthSecretName: "opencode-auth-1",
      plan: plan(),
      queueName: "momokaya-pipeline",
    });

    const runner = manifest.spec.templates.find(
      (template) => template.name === "task-one"
    )?.container;
    const dag = manifest.spec.templates.find(
      (template) => template.name === "pipeline"
    )?.dag;

    expect(manifest.spec.podMetadata?.labels).toEqual({
      "kueue.x-k8s.io/queue-name": "momokaya-pipeline",
    });
    expect(manifest.spec.imagePullSecrets).toEqual([
      { name: "ghcr-pull-secret" },
    ]);
    expect(dag?.tasks[0]).toMatchObject({
      name: "node-one",
      template: "task-one",
    });
    expect(runner?.args).toEqual([
      "runner-command",
      "--payload-file",
      "/etc/pipeline/payload.json",
      "--schedule-file",
      "/etc/pipeline/schedule.yaml",
    ]);
    expect(runner?.command).toEqual(["moka"]);
    expect(runner?.env ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "PIPELINE_WORKFLOW_ID" }),
        expect.objectContaining({ name: "PIPELINE_TASK_ID" }),
      ])
    );
    expect(runner?.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mountPath: "/etc/pipeline/payload.json" }),
        expect.objectContaining({ mountPath: "/etc/pipeline/schedule.yaml" }),
        expect.objectContaining({ mountPath: "/etc/pipeline/task.json" }),
        expect.objectContaining({ mountPath: "/etc/pipeline/event-auth" }),
        expect.objectContaining({
          mountPath: "/root/.local/share/opencode/auth.json",
        }),
        expect.objectContaining({ mountPath: "/root/.gitconfig" }),
      ])
    );
    expect(runner).not.toHaveProperty("outputs");
    expect(manifest.spec.onExit).toBe("pipeline-finalizer");
  });

  it("rejects invalid hand-shaped Workflow resources", () => {
    expect(() =>
      runnerArgoWorkflowManifestSchema.parse({
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Workflow",
        metadata: { namespace: "momokaya-pipeline" },
        spec: {
          entrypoint: "pipeline",
          serviceAccountName: "pipeline-runner",
          templates: [],
          volumes: [],
        },
      })
    ).toThrow(z.ZodError);
  });

  it("stringifies only schema-valid Workflow resources", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    expect(stringifyRunnerArgoWorkflow(manifest)).toContain(
      "apiVersion: argoproj.io/v1alpha1"
    );
  });
});
