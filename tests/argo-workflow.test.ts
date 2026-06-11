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
  namespace: "workflow-namespace",
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
        namespace: "workflow-namespace",
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
      eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
      eventAuthSecretName: "pipeline-runner-event-auth",
      gitCredentialsSecretName: "git-credentials-secret",
      githubAuthSecretName: "github-auth-secret",
      imagePullSecretName: "image-pull-secret",
      opencodeAuthSecretName: "opencode-auth-secret",
      plan: plan(),
      queueName: "pipeline-queue",
    });

    const runner = manifest.spec.templates.find(
      (template) => template.name === "task-one"
    )?.container;
    const dag = manifest.spec.templates.find(
      (template) => template.name === "pipeline"
    )?.dag;

    expect(manifest.spec.podMetadata?.labels).toEqual({
      "kueue.x-k8s.io/queue-name": "pipeline-queue",
    });
    expect(manifest.spec.imagePullSecrets).toEqual([
      { name: "image-pull-secret" },
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
    expect(runner?.env).toEqual(
      expect.arrayContaining([
        { name: "CODEX_AUTH_PER_PROJECT_ACCOUNTS", value: "0" },
      ])
    );
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
        expect.objectContaining({ mountPath: "/etc/pipeline/git-credentials" }),
        expect.objectContaining({
          mountPath: "/root/.local/share/opencode/auth.json",
        }),
        expect.objectContaining({ mountPath: "/root/.config/gh/hosts.yml" }),
      ])
    );
    expect(runner?.volumeMounts).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ mountPath: "/root/.gitconfig" }),
        expect.objectContaining({ mountPath: "/root/.git-credentials" }),
      ])
    );
    expect(manifest.spec.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runner-git-credentials",
          secret: expect.objectContaining({
            defaultMode: 0o400,
            items: expect.arrayContaining([
              { key: "username", path: "username" },
              { key: "password", path: "password" },
              { key: "identity", path: "identity" },
              { key: "known_hosts", path: "known_hosts" },
            ]),
            optional: true,
            secretName: "git-credentials-secret",
          }),
        }),
      ])
    );
    expect(manifest.spec.volumes).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ emptyDir: expect.anything() }),
      ])
    );
    expect(manifest.spec.templates).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ initContainers: expect.anything() }),
      ])
    );
    expect(runner).not.toHaveProperty("outputs");
    expect(manifest.spec.onExit).toBe("pipeline-finalizer");
  });

  it("disables per-project Codex account pools in the finalizer too", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    const finalizer = manifest.spec.templates.find(
      (template) => template.name === "pipeline-finalizer"
    )?.container;

    expect(finalizer?.env).toEqual(
      expect.arrayContaining([
        { name: "CODEX_AUTH_PER_PROJECT_ACCOUNTS", value: "0" },
      ])
    );
  });

  it("does not use the GitHub auth Secret for git credentials", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      githubAuthSecretName: "github-auth-secret",
      plan: plan(),
    });

    expect(manifest.spec.volumes).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ name: "runner-git-credentials" }),
      ])
    );
  });

  it("rejects invalid hand-shaped Workflow resources", () => {
    expect(() =>
      runnerArgoWorkflowManifestSchema.parse({
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Workflow",
        metadata: { namespace: "workflow-namespace" },
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
