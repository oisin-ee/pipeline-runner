import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ArgoGraphCompilerError,
  compileArgoExecutionGraph,
} from "../src/argo-graph";
import {
  buildDynamicRunnerArgoWorkflowManifest,
  buildRunnerArgoWorkflowManifest,
  runnerArgoWorkflowManifestSchema,
  stringifyRunnerArgoWorkflow,
} from "../src/argo-workflow";
import type { PipelineConfig } from "../src/config";
import { loadPipelineConfig, parsePipelineConfigParts } from "../src/config";
import { compileWorkflowPlan } from "../src/planning/compile";

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
  brokerAuth: {
    secretKey: "api-key",
    secretName: "broker-api-key",
    url: "https://cliproxy.momokaya.ee",
  },
  generateName: "pipeline-run-",
  namespace: "workflow-namespace",
  payloadConfigMapName: "pipeline-payload-run-1",
  scheduleConfigMapName: "pipeline-schedule-run-1",
  taskDescriptorConfigMapName: "pipeline-task-descriptors-run-1",
};

const RUNNER_RETRY_STRATEGY = {
  expression:
    "lastRetry.status == 'Error' || (lastRetry.exitCode != '0' && lastRetry.exitCode != '1')",
  limit: "3",
  retryPolicy: "Always",
};

// The expression is long enough that the YAML serializer folds it across lines
// (a plain-scalar fold that unfolds to the single-line expression on parse), so
// inter-token whitespace is matched with \s+ to tolerate the wrap.
const RETRY_STRATEGY_FRAGMENT_PATTERN =
  /retryStrategy:\n\s+expression: lastRetry\.status == 'Error' \|\|\s+\(lastRetry\.exitCode != '0'\s+&&\s+lastRetry\.exitCode != '1'\)\n\s+limit: "3"\n\s+retryPolicy: Always/;
const ARGO_OWNER_FILES = [
  "src/remote/argo/model.ts",
  "src/remote/argo/policy.ts",
  "src/remote/argo/storage.ts",
  "src/remote/argo/templates.ts",
] as const;

function retryStrategyForTemplate(
  manifest: ReturnType<typeof buildRunnerArgoWorkflowManifest>,
  templateName: string
) {
  return Object.getOwnPropertyDescriptor(
    manifest.spec.templates.find(
      (template) => template.name === templateName
    ) ?? {},
    "retryStrategy"
  )?.value;
}

describe("runner Argo Workflow manifest", () => {
  it("renders dynamic DB-drain workflow with selector output, withParam, and recursive drain", () => {
    const manifest = buildDynamicRunnerArgoWorkflowManifest({
      brokerAuth: BASE_OPTIONS.brokerAuth,
      dbAuth: {
        secretKey: "db-url",
        secretName: "moka-db",
      },
      generateName: "pipeline-run-",
      namespace: "workflow-namespace",
      payloadConfigMapName: "pipeline-payload-run-1",
      workflowId: "schedule-run-1-root",
    });

    expect(runnerArgoWorkflowManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.spec.volumes).toEqual([
      {
        configMap: {
          items: [{ key: "payload.json", path: "payload.json" }],
          name: "pipeline-payload-run-1",
        },
        name: "runner-payload",
      },
    ]);
    expect(JSON.stringify(manifest)).not.toContain("runner-schedule");
    expect(JSON.stringify(manifest)).not.toContain("runner-task-descriptor");

    const entrypoint = manifest.spec.templates.find(
      (template) => template.name === "pipeline"
    );
    expect(entrypoint?.steps?.flat().map((step) => step.name)).toEqual([
      "pre-research",
      "pre-planning",
      "generate-schedule",
      "drain-ready-waves",
    ]);

    const selector = manifest.spec.templates.find(
      (template) => template.name === "select-ready-wave"
    );
    expect(selector?.outputs?.parameters).toEqual([
      {
        name: "ready-node-ids",
        valueFrom: { path: "/tmp/moka-ready-node-ids.json" },
      },
    ]);

    const drain = manifest.spec.templates.find(
      (template) => template.name === "drain-ready-waves"
    );
    expect(drain?.steps?.[1]?.[0]).toMatchObject({
      arguments: {
        parameters: [{ name: "node-id", value: "{{item}}" }],
      },
      name: "run-ready-node",
      template: "runner-command",
      withParam:
        "{{steps.select-ready-wave.outputs.parameters.ready-node-ids}}",
    });
    expect(drain?.steps?.[2]?.[0]).toMatchObject({
      name: "drain-next-wave",
      template: "drain-ready-waves",
      when: "{{steps.select-ready-wave.outputs.parameters.ready-node-ids}} != []",
    });
  });

  it("keeps rendering pure and separates Argo policy owners", () => {
    const missingOwnerFiles = ARGO_OWNER_FILES.filter(
      (path) => !existsSync(join(process.cwd(), path))
    );
    const rendererSource = readFileSync(
      join(process.cwd(), "src/argo-workflow.ts"),
      "utf8"
    );
    const policySource = readFileSync(
      join(process.cwd(), "src/remote/argo/policy.ts"),
      "utf8"
    );
    const storageSource = readFileSync(
      join(process.cwd(), "src/remote/argo/storage.ts"),
      "utf8"
    );

    expect(missingOwnerFiles).toEqual([]);
    expect(rendererSource).not.toContain("@kubernetes/client-node");
    expect(rendererSource).not.toContain("createNamespaced");
    expect(policySource).toContain("runnerRetryStrategy");
    expect(policySource).toContain("runnerTemplateResources");
    expect(policySource).toContain("runnerContainerEnv");
    expect(storageSource).toContain("appendEventAuthStorage");
    expect(storageSource).toContain("appendGitCredentialsStorage");
  });

  // AC #6: Golden full-manifest snapshot covering representative multi-node manifest
  it("matches the golden full-manifest snapshot for a representative multi-node workflow", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      activeDeadlineSeconds: 7200,
      eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
      eventAuthSecretName: "pipeline-runner-event-auth",
      gitCredentialsSecretName: "git-credentials-secret",
      githubAuthSecretName: "github-auth-secret",
      imagePullSecretName: "image-pull-secret",
      plan: plan(),
      ttlStrategy: {
        secondsAfterCompletion: 3600,
        secondsAfterFailure: 7200,
        secondsAfterSuccess: 1800,
      },
    });

    expect(runnerArgoWorkflowManifestSchema.parse(manifest)).toEqual(manifest);

    expect(manifest).toMatchInlineSnapshot(`
      {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Workflow",
        "metadata": {
          "annotations": {},
          "generateName": "pipeline-run-",
          "labels": {
            "pipeline.oisin.dev/source": "argo-workflow",
            "pipeline.oisin.dev/workflow": "argo",
          },
          "namespace": "workflow-namespace",
        },
        "spec": {
          "activeDeadlineSeconds": 7200,
          "entrypoint": "pipeline",
          "imagePullSecrets": [
            {
              "name": "image-pull-secret",
            },
          ],
          "onExit": "pipeline-finalizer",
          "serviceAccountName": "pipeline-runner",
          "templates": [
            {
              "dag": {
                "tasks": [
                  {
                    "name": "workflow-start",
                    "template": "workflow-start",
                  },
                  {
                    "dependencies": [
                      "workflow-start",
                    ],
                    "name": "node-one",
                    "template": "task-one",
                  },
                  {
                    "dependencies": [
                      "workflow-start",
                      "node-one",
                    ],
                    "name": "node-two",
                    "template": "task-two",
                  },
                  {
                    "dependencies": [
                      "workflow-start",
                      "node-one",
                    ],
                    "name": "node-three",
                    "template": "task-three",
                  },
                ],
              },
              "name": "pipeline",
            },
            {
              "activeDeadlineSeconds": 5400,
              "container": {
                "args": [
                  "runner-lifecycle",
                  "--phase",
                  "workflow.start",
                  "--payload-file",
                  "/etc/pipeline/payload.json",
                  "--schedule-file",
                  "/etc/pipeline/schedule.yaml",
                ],
                "command": [
                  "moka",
                ],
                "env": [
                  {
                    "name": "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
                    "value": "0",
                  },
                  {
                    "name": "PIPELINE_AGENT_TIMEOUT_MS",
                    "value": "600000",
                  },
                  {
                    "name": "PIPELINE_AGENT_IDLE_TIMEOUT_MS",
                    "value": "180000",
                  },
                  {
                    "name": "PIPELINE_DISABLED_MODELS",
                    "value": "opencode-go/qwen3.7-max",
                  },
                  {
                    "name": "BROKER_URL",
                    "value": "https://cliproxy.momokaya.ee",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_NAME",
                    "value": "broker-api-key",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_KEY",
                    "value": "api-key",
                  },
                  {
                    "name": "BROKER_API_KEY",
                    "valueFrom": {
                      "secretKeyRef": {
                        "key": "api-key",
                        "name": "broker-api-key",
                      },
                    },
                  },
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
                "resources": {
                  "limits": {
                    "cpu": "4",
                    "memory": "12Gi",
                  },
                  "requests": {
                    "cpu": "1",
                    "memory": "5Gi",
                  },
                },
                "volumeMounts": [
                  {
                    "mountPath": "/etc/pipeline/payload.json",
                    "name": "runner-payload",
                    "readOnly": true,
                    "subPath": "payload.json",
                  },
                  {
                    "mountPath": "/etc/pipeline/schedule.yaml",
                    "name": "runner-schedule",
                    "readOnly": true,
                    "subPath": "schedule.yaml",
                  },
                  {
                    "mountPath": "/etc/pipeline/event-auth",
                    "name": "runner-event-auth",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/etc/pipeline/git-credentials",
                    "name": "runner-git-credentials",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/root/.config/gh/hosts.yml",
                    "name": "github-auth",
                    "readOnly": true,
                    "subPath": "hosts.yml",
                  },
                ],
              },
              "name": "workflow-start",
              "retryStrategy": {
                "expression": "lastRetry.status == 'Error' || (lastRetry.exitCode != '0' && lastRetry.exitCode != '1')",
                "limit": "3",
                "retryPolicy": "Always",
              },
            },
            {
              "activeDeadlineSeconds": 5400,
              "container": {
                "args": [
                  "runner-command",
                  "--payload-file",
                  "/etc/pipeline/payload.json",
                  "--schedule-file",
                  "/etc/pipeline/schedule.yaml",
                ],
                "command": [
                  "moka",
                ],
                "env": [
                  {
                    "name": "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
                    "value": "0",
                  },
                  {
                    "name": "PIPELINE_AGENT_TIMEOUT_MS",
                    "value": "600000",
                  },
                  {
                    "name": "PIPELINE_AGENT_IDLE_TIMEOUT_MS",
                    "value": "180000",
                  },
                  {
                    "name": "PIPELINE_DISABLED_MODELS",
                    "value": "opencode-go/qwen3.7-max",
                  },
                  {
                    "name": "BROKER_URL",
                    "value": "https://cliproxy.momokaya.ee",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_NAME",
                    "value": "broker-api-key",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_KEY",
                    "value": "api-key",
                  },
                  {
                    "name": "BROKER_API_KEY",
                    "valueFrom": {
                      "secretKeyRef": {
                        "key": "api-key",
                        "name": "broker-api-key",
                      },
                    },
                  },
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
                "resources": {
                  "limits": {
                    "cpu": "4",
                    "memory": "12Gi",
                  },
                  "requests": {
                    "cpu": "1",
                    "memory": "5Gi",
                  },
                },
                "volumeMounts": [
                  {
                    "mountPath": "/etc/pipeline/payload.json",
                    "name": "runner-payload",
                    "readOnly": true,
                    "subPath": "payload.json",
                  },
                  {
                    "mountPath": "/etc/pipeline/schedule.yaml",
                    "name": "runner-schedule",
                    "readOnly": true,
                    "subPath": "schedule.yaml",
                  },
                  {
                    "mountPath": "/etc/pipeline/event-auth",
                    "name": "runner-event-auth",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/etc/pipeline/git-credentials",
                    "name": "runner-git-credentials",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/root/.config/gh/hosts.yml",
                    "name": "github-auth",
                    "readOnly": true,
                    "subPath": "hosts.yml",
                  },
                  {
                    "mountPath": "/etc/pipeline/task.json",
                    "name": "runner-task-descriptor",
                    "readOnly": true,
                    "subPath": "node-one.json",
                  },
                ],
              },
              "name": "task-one",
              "retryStrategy": {
                "expression": "lastRetry.status == 'Error' || (lastRetry.exitCode != '0' && lastRetry.exitCode != '1')",
                "limit": "3",
                "retryPolicy": "Always",
              },
            },
            {
              "activeDeadlineSeconds": 5400,
              "container": {
                "args": [
                  "runner-command",
                  "--payload-file",
                  "/etc/pipeline/payload.json",
                  "--schedule-file",
                  "/etc/pipeline/schedule.yaml",
                ],
                "command": [
                  "moka",
                ],
                "env": [
                  {
                    "name": "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
                    "value": "0",
                  },
                  {
                    "name": "PIPELINE_AGENT_TIMEOUT_MS",
                    "value": "600000",
                  },
                  {
                    "name": "PIPELINE_AGENT_IDLE_TIMEOUT_MS",
                    "value": "180000",
                  },
                  {
                    "name": "PIPELINE_DISABLED_MODELS",
                    "value": "opencode-go/qwen3.7-max",
                  },
                  {
                    "name": "BROKER_URL",
                    "value": "https://cliproxy.momokaya.ee",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_NAME",
                    "value": "broker-api-key",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_KEY",
                    "value": "api-key",
                  },
                  {
                    "name": "BROKER_API_KEY",
                    "valueFrom": {
                      "secretKeyRef": {
                        "key": "api-key",
                        "name": "broker-api-key",
                      },
                    },
                  },
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
                "resources": {
                  "limits": {
                    "cpu": "4",
                    "memory": "12Gi",
                  },
                  "requests": {
                    "cpu": "1",
                    "memory": "5Gi",
                  },
                },
                "volumeMounts": [
                  {
                    "mountPath": "/etc/pipeline/payload.json",
                    "name": "runner-payload",
                    "readOnly": true,
                    "subPath": "payload.json",
                  },
                  {
                    "mountPath": "/etc/pipeline/schedule.yaml",
                    "name": "runner-schedule",
                    "readOnly": true,
                    "subPath": "schedule.yaml",
                  },
                  {
                    "mountPath": "/etc/pipeline/event-auth",
                    "name": "runner-event-auth",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/etc/pipeline/git-credentials",
                    "name": "runner-git-credentials",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/root/.config/gh/hosts.yml",
                    "name": "github-auth",
                    "readOnly": true,
                    "subPath": "hosts.yml",
                  },
                  {
                    "mountPath": "/etc/pipeline/task.json",
                    "name": "runner-task-descriptor",
                    "readOnly": true,
                    "subPath": "node-two.json",
                  },
                ],
              },
              "name": "task-two",
              "retryStrategy": {
                "expression": "lastRetry.status == 'Error' || (lastRetry.exitCode != '0' && lastRetry.exitCode != '1')",
                "limit": "3",
                "retryPolicy": "Always",
              },
            },
            {
              "activeDeadlineSeconds": 5400,
              "container": {
                "args": [
                  "runner-command",
                  "--payload-file",
                  "/etc/pipeline/payload.json",
                  "--schedule-file",
                  "/etc/pipeline/schedule.yaml",
                ],
                "command": [
                  "moka",
                ],
                "env": [
                  {
                    "name": "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
                    "value": "0",
                  },
                  {
                    "name": "PIPELINE_AGENT_TIMEOUT_MS",
                    "value": "600000",
                  },
                  {
                    "name": "PIPELINE_AGENT_IDLE_TIMEOUT_MS",
                    "value": "180000",
                  },
                  {
                    "name": "PIPELINE_DISABLED_MODELS",
                    "value": "opencode-go/qwen3.7-max",
                  },
                  {
                    "name": "BROKER_URL",
                    "value": "https://cliproxy.momokaya.ee",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_NAME",
                    "value": "broker-api-key",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_KEY",
                    "value": "api-key",
                  },
                  {
                    "name": "BROKER_API_KEY",
                    "valueFrom": {
                      "secretKeyRef": {
                        "key": "api-key",
                        "name": "broker-api-key",
                      },
                    },
                  },
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
                "resources": {
                  "limits": {
                    "cpu": "4",
                    "memory": "12Gi",
                  },
                  "requests": {
                    "cpu": "1",
                    "memory": "5Gi",
                  },
                },
                "volumeMounts": [
                  {
                    "mountPath": "/etc/pipeline/payload.json",
                    "name": "runner-payload",
                    "readOnly": true,
                    "subPath": "payload.json",
                  },
                  {
                    "mountPath": "/etc/pipeline/schedule.yaml",
                    "name": "runner-schedule",
                    "readOnly": true,
                    "subPath": "schedule.yaml",
                  },
                  {
                    "mountPath": "/etc/pipeline/event-auth",
                    "name": "runner-event-auth",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/etc/pipeline/git-credentials",
                    "name": "runner-git-credentials",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/root/.config/gh/hosts.yml",
                    "name": "github-auth",
                    "readOnly": true,
                    "subPath": "hosts.yml",
                  },
                  {
                    "mountPath": "/etc/pipeline/task.json",
                    "name": "runner-task-descriptor",
                    "readOnly": true,
                    "subPath": "node-three.json",
                  },
                ],
              },
              "name": "task-three",
              "retryStrategy": {
                "expression": "lastRetry.status == 'Error' || (lastRetry.exitCode != '0' && lastRetry.exitCode != '1')",
                "limit": "3",
                "retryPolicy": "Always",
              },
            },
            {
              "activeDeadlineSeconds": 5400,
              "container": {
                "args": [
                  "runner-finalize",
                  "--payload-file",
                  "/etc/pipeline/payload.json",
                  "--schedule-file",
                  "/etc/pipeline/schedule.yaml",
                  "--argo-status",
                  "{{workflow.status}}",
                ],
                "command": [
                  "moka",
                ],
                "env": [
                  {
                    "name": "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
                    "value": "0",
                  },
                  {
                    "name": "PIPELINE_AGENT_TIMEOUT_MS",
                    "value": "600000",
                  },
                  {
                    "name": "PIPELINE_AGENT_IDLE_TIMEOUT_MS",
                    "value": "180000",
                  },
                  {
                    "name": "PIPELINE_DISABLED_MODELS",
                    "value": "opencode-go/qwen3.7-max",
                  },
                  {
                    "name": "BROKER_URL",
                    "value": "https://cliproxy.momokaya.ee",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_NAME",
                    "value": "broker-api-key",
                  },
                  {
                    "name": "PIPELINE_BROKER_SECRET_KEY",
                    "value": "api-key",
                  },
                  {
                    "name": "BROKER_API_KEY",
                    "valueFrom": {
                      "secretKeyRef": {
                        "key": "api-key",
                        "name": "broker-api-key",
                      },
                    },
                  },
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
                "resources": {
                  "limits": {
                    "cpu": "4",
                    "memory": "12Gi",
                  },
                  "requests": {
                    "cpu": "1",
                    "memory": "5Gi",
                  },
                },
                "volumeMounts": [
                  {
                    "mountPath": "/etc/pipeline/payload.json",
                    "name": "runner-payload",
                    "readOnly": true,
                    "subPath": "payload.json",
                  },
                  {
                    "mountPath": "/etc/pipeline/schedule.yaml",
                    "name": "runner-schedule",
                    "readOnly": true,
                    "subPath": "schedule.yaml",
                  },
                  {
                    "mountPath": "/etc/pipeline/event-auth",
                    "name": "runner-event-auth",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/etc/pipeline/git-credentials",
                    "name": "runner-git-credentials",
                    "readOnly": true,
                  },
                  {
                    "mountPath": "/root/.config/gh/hosts.yml",
                    "name": "github-auth",
                    "readOnly": true,
                    "subPath": "hosts.yml",
                  },
                ],
              },
              "name": "pipeline-finalizer",
            },
          ],
          "ttlStrategy": {
            "secondsAfterCompletion": 3600,
            "secondsAfterFailure": 7200,
            "secondsAfterSuccess": 1800,
          },
          "volumes": [
            {
              "configMap": {
                "items": [
                  {
                    "key": "payload.json",
                    "path": "payload.json",
                  },
                ],
                "name": "pipeline-payload-run-1",
              },
              "name": "runner-payload",
            },
            {
              "configMap": {
                "items": [
                  {
                    "key": "schedule.yaml",
                    "path": "schedule.yaml",
                  },
                ],
                "name": "pipeline-schedule-run-1",
              },
              "name": "runner-schedule",
            },
            {
              "configMap": {
                "items": [
                  {
                    "key": "node-one.json",
                    "path": "node-one.json",
                  },
                  {
                    "key": "node-two.json",
                    "path": "node-two.json",
                  },
                  {
                    "key": "node-three.json",
                    "path": "node-three.json",
                  },
                ],
                "name": "pipeline-task-descriptors-run-1",
              },
              "name": "runner-task-descriptor",
            },
            {
              "name": "runner-event-auth",
              "secret": {
                "items": [
                  {
                    "key": "EVENT_AUTH_TOKEN_KEY",
                    "path": "EVENT_AUTH_TOKEN_KEY",
                  },
                ],
                "secretName": "pipeline-runner-event-auth",
              },
            },
            {
              "name": "runner-git-credentials",
              "secret": {
                "defaultMode": 256,
                "secretName": "git-credentials-secret",
              },
            },
            {
              "name": "github-auth",
              "secret": {
                "items": [
                  {
                    "key": "hosts.yml",
                    "path": "hosts.yml",
                  },
                ],
                "secretName": "github-auth-secret",
              },
            },
          ],
        },
      }
    `);
    expect(stringifyRunnerArgoWorkflow(manifest)).toMatchInlineSnapshot(`
      "apiVersion: argoproj.io/v1alpha1
      kind: Workflow
      metadata:
        annotations: {}
        generateName: pipeline-run-
        labels:
          pipeline.oisin.dev/source: argo-workflow
          pipeline.oisin.dev/workflow: argo
        namespace: workflow-namespace
      spec:
        activeDeadlineSeconds: 7200
        entrypoint: pipeline
        imagePullSecrets:
          - name: image-pull-secret
        serviceAccountName: pipeline-runner
        onExit: pipeline-finalizer
        templates:
          - dag:
              tasks:
                - name: workflow-start
                  template: workflow-start
                - dependencies:
                    - workflow-start
                  name: node-one
                  template: task-one
                - dependencies:
                    - workflow-start
                    - node-one
                  name: node-two
                  template: task-two
                - dependencies:
                    - workflow-start
                    - node-one
                  name: node-three
                  template: task-three
            name: pipeline
          - container:
              args:
                - runner-lifecycle
                - --phase
                - workflow.start
                - --payload-file
                - /etc/pipeline/payload.json
                - --schedule-file
                - /etc/pipeline/schedule.yaml
              command:
                - moka
              env:
                - name: CODEX_AUTH_PER_PROJECT_ACCOUNTS
                  value: "0"
                - name: PIPELINE_AGENT_TIMEOUT_MS
                  value: "600000"
                - name: PIPELINE_AGENT_IDLE_TIMEOUT_MS
                  value: "180000"
                - name: PIPELINE_DISABLED_MODELS
                  value: opencode-go/qwen3.7-max
                - name: BROKER_URL
                  value: https://cliproxy.momokaya.ee
                - name: PIPELINE_BROKER_SECRET_NAME
                  value: broker-api-key
                - name: PIPELINE_BROKER_SECRET_KEY
                  value: api-key
                - name: BROKER_API_KEY
                  valueFrom:
                    secretKeyRef:
                      key: api-key
                      name: broker-api-key
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
              resources:
                limits:
                  cpu: "4"
                  memory: 12Gi
                requests:
                  cpu: "1"
                  memory: 5Gi
              volumeMounts:
                - mountPath: /etc/pipeline/payload.json
                  name: runner-payload
                  readOnly: true
                  subPath: payload.json
                - mountPath: /etc/pipeline/schedule.yaml
                  name: runner-schedule
                  readOnly: true
                  subPath: schedule.yaml
                - mountPath: /etc/pipeline/event-auth
                  name: runner-event-auth
                  readOnly: true
                - mountPath: /etc/pipeline/git-credentials
                  name: runner-git-credentials
                  readOnly: true
                - mountPath: /root/.config/gh/hosts.yml
                  name: github-auth
                  readOnly: true
                  subPath: hosts.yml
            activeDeadlineSeconds: 5400
            name: workflow-start
            retryStrategy:
              expression: lastRetry.status == 'Error' || (lastRetry.exitCode != '0' &&
                lastRetry.exitCode != '1')
              limit: "3"
              retryPolicy: Always
          - container:
              args:
                - runner-command
                - --payload-file
                - /etc/pipeline/payload.json
                - --schedule-file
                - /etc/pipeline/schedule.yaml
              command:
                - moka
              env:
                - name: CODEX_AUTH_PER_PROJECT_ACCOUNTS
                  value: "0"
                - name: PIPELINE_AGENT_TIMEOUT_MS
                  value: "600000"
                - name: PIPELINE_AGENT_IDLE_TIMEOUT_MS
                  value: "180000"
                - name: PIPELINE_DISABLED_MODELS
                  value: opencode-go/qwen3.7-max
                - name: BROKER_URL
                  value: https://cliproxy.momokaya.ee
                - name: PIPELINE_BROKER_SECRET_NAME
                  value: broker-api-key
                - name: PIPELINE_BROKER_SECRET_KEY
                  value: api-key
                - name: BROKER_API_KEY
                  valueFrom:
                    secretKeyRef:
                      key: api-key
                      name: broker-api-key
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
              resources:
                limits:
                  cpu: "4"
                  memory: 12Gi
                requests:
                  cpu: "1"
                  memory: 5Gi
              volumeMounts:
                - mountPath: /etc/pipeline/payload.json
                  name: runner-payload
                  readOnly: true
                  subPath: payload.json
                - mountPath: /etc/pipeline/schedule.yaml
                  name: runner-schedule
                  readOnly: true
                  subPath: schedule.yaml
                - mountPath: /etc/pipeline/event-auth
                  name: runner-event-auth
                  readOnly: true
                - mountPath: /etc/pipeline/git-credentials
                  name: runner-git-credentials
                  readOnly: true
                - mountPath: /root/.config/gh/hosts.yml
                  name: github-auth
                  readOnly: true
                  subPath: hosts.yml
                - mountPath: /etc/pipeline/task.json
                  name: runner-task-descriptor
                  readOnly: true
                  subPath: node-one.json
            activeDeadlineSeconds: 5400
            name: task-one
            retryStrategy:
              expression: lastRetry.status == 'Error' || (lastRetry.exitCode != '0' &&
                lastRetry.exitCode != '1')
              limit: "3"
              retryPolicy: Always
          - container:
              args:
                - runner-command
                - --payload-file
                - /etc/pipeline/payload.json
                - --schedule-file
                - /etc/pipeline/schedule.yaml
              command:
                - moka
              env:
                - name: CODEX_AUTH_PER_PROJECT_ACCOUNTS
                  value: "0"
                - name: PIPELINE_AGENT_TIMEOUT_MS
                  value: "600000"
                - name: PIPELINE_AGENT_IDLE_TIMEOUT_MS
                  value: "180000"
                - name: PIPELINE_DISABLED_MODELS
                  value: opencode-go/qwen3.7-max
                - name: BROKER_URL
                  value: https://cliproxy.momokaya.ee
                - name: PIPELINE_BROKER_SECRET_NAME
                  value: broker-api-key
                - name: PIPELINE_BROKER_SECRET_KEY
                  value: api-key
                - name: BROKER_API_KEY
                  valueFrom:
                    secretKeyRef:
                      key: api-key
                      name: broker-api-key
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
              resources:
                limits:
                  cpu: "4"
                  memory: 12Gi
                requests:
                  cpu: "1"
                  memory: 5Gi
              volumeMounts:
                - mountPath: /etc/pipeline/payload.json
                  name: runner-payload
                  readOnly: true
                  subPath: payload.json
                - mountPath: /etc/pipeline/schedule.yaml
                  name: runner-schedule
                  readOnly: true
                  subPath: schedule.yaml
                - mountPath: /etc/pipeline/event-auth
                  name: runner-event-auth
                  readOnly: true
                - mountPath: /etc/pipeline/git-credentials
                  name: runner-git-credentials
                  readOnly: true
                - mountPath: /root/.config/gh/hosts.yml
                  name: github-auth
                  readOnly: true
                  subPath: hosts.yml
                - mountPath: /etc/pipeline/task.json
                  name: runner-task-descriptor
                  readOnly: true
                  subPath: node-two.json
            activeDeadlineSeconds: 5400
            name: task-two
            retryStrategy:
              expression: lastRetry.status == 'Error' || (lastRetry.exitCode != '0' &&
                lastRetry.exitCode != '1')
              limit: "3"
              retryPolicy: Always
          - container:
              args:
                - runner-command
                - --payload-file
                - /etc/pipeline/payload.json
                - --schedule-file
                - /etc/pipeline/schedule.yaml
              command:
                - moka
              env:
                - name: CODEX_AUTH_PER_PROJECT_ACCOUNTS
                  value: "0"
                - name: PIPELINE_AGENT_TIMEOUT_MS
                  value: "600000"
                - name: PIPELINE_AGENT_IDLE_TIMEOUT_MS
                  value: "180000"
                - name: PIPELINE_DISABLED_MODELS
                  value: opencode-go/qwen3.7-max
                - name: BROKER_URL
                  value: https://cliproxy.momokaya.ee
                - name: PIPELINE_BROKER_SECRET_NAME
                  value: broker-api-key
                - name: PIPELINE_BROKER_SECRET_KEY
                  value: api-key
                - name: BROKER_API_KEY
                  valueFrom:
                    secretKeyRef:
                      key: api-key
                      name: broker-api-key
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
              resources:
                limits:
                  cpu: "4"
                  memory: 12Gi
                requests:
                  cpu: "1"
                  memory: 5Gi
              volumeMounts:
                - mountPath: /etc/pipeline/payload.json
                  name: runner-payload
                  readOnly: true
                  subPath: payload.json
                - mountPath: /etc/pipeline/schedule.yaml
                  name: runner-schedule
                  readOnly: true
                  subPath: schedule.yaml
                - mountPath: /etc/pipeline/event-auth
                  name: runner-event-auth
                  readOnly: true
                - mountPath: /etc/pipeline/git-credentials
                  name: runner-git-credentials
                  readOnly: true
                - mountPath: /root/.config/gh/hosts.yml
                  name: github-auth
                  readOnly: true
                  subPath: hosts.yml
                - mountPath: /etc/pipeline/task.json
                  name: runner-task-descriptor
                  readOnly: true
                  subPath: node-three.json
            activeDeadlineSeconds: 5400
            name: task-three
            retryStrategy:
              expression: lastRetry.status == 'Error' || (lastRetry.exitCode != '0' &&
                lastRetry.exitCode != '1')
              limit: "3"
              retryPolicy: Always
          - container:
              args:
                - runner-finalize
                - --payload-file
                - /etc/pipeline/payload.json
                - --schedule-file
                - /etc/pipeline/schedule.yaml
                - --argo-status
                - "{{workflow.status}}"
              command:
                - moka
              env:
                - name: CODEX_AUTH_PER_PROJECT_ACCOUNTS
                  value: "0"
                - name: PIPELINE_AGENT_TIMEOUT_MS
                  value: "600000"
                - name: PIPELINE_AGENT_IDLE_TIMEOUT_MS
                  value: "180000"
                - name: PIPELINE_DISABLED_MODELS
                  value: opencode-go/qwen3.7-max
                - name: BROKER_URL
                  value: https://cliproxy.momokaya.ee
                - name: PIPELINE_BROKER_SECRET_NAME
                  value: broker-api-key
                - name: PIPELINE_BROKER_SECRET_KEY
                  value: api-key
                - name: BROKER_API_KEY
                  valueFrom:
                    secretKeyRef:
                      key: api-key
                      name: broker-api-key
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
              resources:
                limits:
                  cpu: "4"
                  memory: 12Gi
                requests:
                  cpu: "1"
                  memory: 5Gi
              volumeMounts:
                - mountPath: /etc/pipeline/payload.json
                  name: runner-payload
                  readOnly: true
                  subPath: payload.json
                - mountPath: /etc/pipeline/schedule.yaml
                  name: runner-schedule
                  readOnly: true
                  subPath: schedule.yaml
                - mountPath: /etc/pipeline/event-auth
                  name: runner-event-auth
                  readOnly: true
                - mountPath: /etc/pipeline/git-credentials
                  name: runner-git-credentials
                  readOnly: true
                - mountPath: /root/.config/gh/hosts.yml
                  name: github-auth
                  readOnly: true
                  subPath: hosts.yml
            activeDeadlineSeconds: 5400
            name: pipeline-finalizer
        ttlStrategy:
          secondsAfterCompletion: 3600
          secondsAfterFailure: 7200
          secondsAfterSuccess: 1800
        volumes:
          - configMap:
              items:
                - key: payload.json
                  path: payload.json
              name: pipeline-payload-run-1
            name: runner-payload
          - configMap:
              items:
                - key: schedule.yaml
                  path: schedule.yaml
              name: pipeline-schedule-run-1
            name: runner-schedule
          - configMap:
              items:
                - key: node-one.json
                  path: node-one.json
                - key: node-two.json
                  path: node-two.json
                - key: node-three.json
                  path: node-three.json
              name: pipeline-task-descriptors-run-1
            name: runner-task-descriptor
          - name: runner-event-auth
            secret:
              items:
                - key: EVENT_AUTH_TOKEN_KEY
                  path: EVENT_AUTH_TOKEN_KEY
              secretName: pipeline-runner-event-auth
          - name: runner-git-credentials
            secret:
              defaultMode: 256
              secretName: git-credentials-secret
          - name: github-auth
            secret:
              items:
                - key: hosts.yml
                  path: hosts.yml
              secretName: github-auth-secret
      "
    `);
  });

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

  it("injects MOKA_DB_URL via secretKeyRef into every runner container when dbAuth is configured", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      dbAuth: { secretKey: "db-url", secretName: "momokaya-db" },
      plan: plan(),
    });

    const runnerTemplates = manifest.spec.templates.filter(
      (template) => template.container !== undefined
    );
    expect(runnerTemplates.length).toBeGreaterThan(0);
    for (const template of runnerTemplates) {
      const env = template.container?.env ?? [];
      expect(env).toContainEqual({
        name: "MOKA_DB_URL",
        valueFrom: {
          secretKeyRef: { key: "db-url", name: "momokaya-db" },
        },
      });
    }
  });

  it("omits MOKA_DB_URL from runner containers when dbAuth is absent (safe default)", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    const runnerTemplates = manifest.spec.templates.filter(
      (template) => template.container !== undefined
    );
    expect(runnerTemplates.length).toBeGreaterThan(0);
    for (const template of runnerTemplates) {
      const env = template.container?.env ?? [];
      expect(env).not.toContainEqual(
        expect.objectContaining({ name: "MOKA_DB_URL" })
      );
    }
  });

  it("injects PIPELINE_MCP_GATEWAY_AUTHORIZATION via secretKeyRef into every runner container when mcpGatewayAuth is configured", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      mcpGatewayAuth: {
        secretKey: "pipeline-mcp-gateway-authorization",
        secretName: "pipeline-runner-mcp-auth",
      },
      plan: plan(),
    });

    const runnerTemplates = manifest.spec.templates.filter(
      (template) => template.container !== undefined
    );
    expect(runnerTemplates.length).toBeGreaterThan(0);
    for (const template of runnerTemplates) {
      const env = template.container?.env ?? [];
      expect(env).toContainEqual({
        name: "PIPELINE_MCP_GATEWAY_AUTHORIZATION",
        valueFrom: {
          secretKeyRef: {
            key: "pipeline-mcp-gateway-authorization",
            name: "pipeline-runner-mcp-auth",
          },
        },
      });
    }
  });

  it("defaults the mcpGatewayAuth secretKey to pipeline-mcp-gateway-authorization when only a secretName is given", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      mcpGatewayAuth: { secretName: "pipeline-runner-mcp-auth" },
      plan: plan(),
    });

    const runnerTemplates = manifest.spec.templates.filter(
      (template) => template.container !== undefined
    );
    expect(runnerTemplates.length).toBeGreaterThan(0);
    for (const template of runnerTemplates) {
      const env = template.container?.env ?? [];
      expect(env).toContainEqual({
        name: "PIPELINE_MCP_GATEWAY_AUTHORIZATION",
        valueFrom: {
          secretKeyRef: {
            key: "pipeline-mcp-gateway-authorization",
            name: "pipeline-runner-mcp-auth",
          },
        },
      });
    }
  });

  it("omits PIPELINE_MCP_GATEWAY_AUTHORIZATION from runner containers when mcpGatewayAuth is absent (safe default)", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    const runnerTemplates = manifest.spec.templates.filter(
      (template) => template.container !== undefined
    );
    expect(runnerTemplates.length).toBeGreaterThan(0);
    for (const template of runnerTemplates) {
      const env = template.container?.env ?? [];
      expect(env).not.toContainEqual(
        expect.objectContaining({ name: "PIPELINE_MCP_GATEWAY_AUTHORIZATION" })
      );
    }
  });

  it("injects BROKER_URL + BROKER_API_KEY (from secret) into every runner container when broker auth is set", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      brokerAuth: {
        secretKey: "api-key",
        secretName: "broker-api-key",
        url: "https://cliproxy.momokaya.ee",
      },
      plan: plan(),
    });

    const runnerTemplates = manifest.spec.templates.filter(
      (template) => template.container !== undefined
    );
    expect(runnerTemplates.length).toBeGreaterThan(0);
    for (const template of runnerTemplates) {
      const env = template.container?.env ?? [];
      expect(env).toContainEqual({
        name: "BROKER_URL",
        value: "https://cliproxy.momokaya.ee",
      });
      expect(env).toContainEqual({
        name: "PIPELINE_BROKER_SECRET_NAME",
        value: "broker-api-key",
      });
      expect(env).toContainEqual({
        name: "PIPELINE_BROKER_SECRET_KEY",
        value: "api-key",
      });
      expect(env).toContainEqual({
        name: "BROKER_API_KEY",
        valueFrom: {
          secretKeyRef: { key: "api-key", name: "broker-api-key" },
        },
      });
    }
  });

  it("rejects remote runner manifests without broker auth", () => {
    const { brokerAuth, ...optionsWithoutBrokerAuth } = BASE_OPTIONS;
    expect(brokerAuth.secretName).toBe("broker-api-key");

    expect(() =>
      Reflect.apply(buildRunnerArgoWorkflowManifest, undefined, [
        {
          ...optionsWithoutBrokerAuth,
          plan: plan(),
        },
      ])
    ).toThrow(z.ZodError);
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
      "node-one": ["workflow-start"],
      "node-three": ["workflow-start", "node-one"],
      "node-two": ["workflow-start", "node-one"],
      "workflow-start": [],
    });
  });

  it("runs workflow.start as an Argo lifecycle task before any DAG node task", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    const dag = manifest.spec.templates.find(
      (template) => template.name === "pipeline"
    )?.dag;
    const startTask = dag?.tasks.find((task) => task.name === "workflow-start");
    const nodeTasks = (dag?.tasks ?? []).filter((task) =>
      task.name.startsWith("node-")
    );
    const startTemplate = manifest.spec.templates.find(
      (template) => template.name === startTask?.template
    )?.container;

    expect(startTask).toMatchObject({
      name: "workflow-start",
      template: "workflow-start",
    });
    expect(startTemplate?.args).toEqual([
      "runner-lifecycle",
      "--phase",
      "workflow.start",
      "--payload-file",
      "/etc/pipeline/payload.json",
      "--schedule-file",
      "/etc/pipeline/schedule.yaml",
    ]);
    expect(nodeTasks).toHaveLength(3);
    expect(
      nodeTasks.every((task) => task.dependencies?.includes("workflow-start"))
    ).toBe(true);
    expect(manifest.spec.onExit).toBe("pipeline-finalizer");
  });

  it("retries runner nodes on transient Argo errors or exit 70, not task failures", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    expect(retryStrategyForTemplate(manifest, "workflow-start")).toEqual(
      RUNNER_RETRY_STRATEGY
    );
    expect(retryStrategyForTemplate(manifest, "task-one")).toEqual(
      RUNNER_RETRY_STRATEGY
    );
    expect(retryStrategyForTemplate(manifest, "task-two")).toEqual(
      RUNNER_RETRY_STRATEGY
    );
    expect(retryStrategyForTemplate(manifest, "task-three")).toEqual(
      RUNNER_RETRY_STRATEGY
    );
    expect(
      retryStrategyForTemplate(manifest, "pipeline-finalizer")
    ).toBeUndefined();

    const rendered = stringifyRunnerArgoWorkflow(manifest);
    expect(rendered).toContain("retryStrategy:\n");
    // Retries any infra/abnormal failure (Argo "Error", exit 70/137/255/…);
    // keeps only clean deterministic task failures (exit 1) out.
    expect(rendered).toContain("retryPolicy: Always");
    expect(rendered.match(RETRY_STRATEGY_FRAGMENT_PATTERN)?.[0]).toBeDefined();
    expect(rendered).toContain("lastRetry.status == 'Error'");
    expect(rendered).toContain("lastRetry.exitCode != '0'");
    expect(rendered).toContain("lastRetry.exitCode != '1'");
    const finalizerTemplate = rendered.slice(
      rendered.indexOf("name: pipeline-finalizer"),
      rendered.indexOf("\n  volumes:")
    );
    expect(finalizerTemplate).not.toContain("retryStrategy:");
  });

  it("bounds every runner pod with activeDeadlineSeconds so a hung node is killed and retried", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    // A hung pod stays Running forever and never trips retryStrategy; the
    // deadline is the only guard that turns an unbounded hang into a bounded,
    // retryable failure. It must cover the lifecycle, every node, and finalize.
    for (const templateName of [
      "workflow-start",
      "task-one",
      "task-two",
      "task-three",
      "pipeline-finalizer",
    ]) {
      const template = manifest.spec.templates.find(
        (candidate) => candidate.name === templateName
      );
      expect(template?.activeDeadlineSeconds).toBe(5400);
    }
  });

  it("accepts retryStrategy on runner templates in the strict Argo schema", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });
    const taskTemplate = manifest.spec.templates.find(
      (template) => template.name === "task-one"
    );

    expect(taskTemplate).toBeDefined();
    const schemaProbe = {
      ...manifest,
      spec: {
        ...manifest.spec,
        templates: manifest.spec.templates.map((template) =>
          template.name === "task-one"
            ? { ...template, retryStrategy: RUNNER_RETRY_STRATEGY }
            : template
        ),
      },
    };

    expect(runnerArgoWorkflowManifestSchema.parse(schemaProbe)).toEqual(
      schemaProbe
    );
  });

  it("passes explicit argv to each runner-command task template", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      eventAuthSecretKey: "EVENT_AUTH_TOKEN_KEY",
      eventAuthSecretName: "pipeline-runner-event-auth",
      gitCredentialsSecretName: "git-credentials-secret",
      githubAuthSecretName: "github-auth-secret",
      imagePullSecretName: "image-pull-secret",
      plan: plan(),
    });

    const runner = manifest.spec.templates.find(
      (template) => template.name === "task-one"
    )?.container;
    const dag = manifest.spec.templates.find(
      (template) => template.name === "pipeline"
    )?.dag;

    expect(manifest.spec.imagePullSecrets).toEqual([
      { name: "image-pull-secret" },
    ]);
    expect(dag?.tasks.find((task) => task.name === "node-one")).toMatchObject({
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
            secretName: "git-credentials-secret",
          }),
        }),
      ])
    );
    expect(
      manifest.spec.volumes.find(
        (volume) => volume.name === "runner-git-credentials"
      )?.secret
    ).not.toMatchObject({ items: expect.anything(), optional: true });
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

  it("compiles agent-kind nodes to runner-command tasks identical to command-kind nodes", () => {
    /*
     * AC#2: Agent nodes lower to the same runner-command template as command
     * and builtin nodes. The runner recovers per-node context (profile, models,
     * instructions) at execution time by compiling the schedule artifact and
     * looking up the node by id. The task descriptor in the ConfigMap carries
     * only the nodeId — it is intentionally minimal and uniform across kinds.
     */
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
  impl:
    runner: opencode
    instructions: { inline: Implement }
`,
      pipeline: `
version: 1
default_workflow: agent-graph
orchestrator:
  profile: orchestrator
workflows:
  agent-graph:
    nodes:
      - id: plan
        kind: agent
        profile: orchestrator
      - id: impl
        kind: agent
        profile: impl
        needs: [plan]
`,
    });
    const agentPlan = compileWorkflowPlan(config, "agent-graph");
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: agentPlan,
    });

    const dag = manifest.spec.templates.find((t) => t.name === "pipeline")?.dag;
    const planTemplate = manifest.spec.templates.find(
      (t) => t.name === "task-plan"
    );
    const implTemplate = manifest.spec.templates.find(
      (t) => t.name === "task-impl"
    );

    // Both agent nodes appear as runner-command tasks in the DAG
    expect(dag?.tasks.map((t) => t.name)).toEqual([
      "workflow-start",
      "node-plan",
      "node-impl",
    ]);
    // impl depends on plan in the Argo DAG
    expect(
      dag?.tasks.find((t) => t.name === "node-impl")?.dependencies
    ).toEqual(["workflow-start", "node-plan"]);
    // All runner-command templates use the same moka runner-command args
    expect(planTemplate?.container?.args).toEqual([
      "runner-command",
      "--payload-file",
      "/etc/pipeline/payload.json",
      "--schedule-file",
      "/etc/pipeline/schedule.yaml",
    ]);
    expect(implTemplate?.container?.args).toEqual(
      planTemplate?.container?.args
    );
    // task-descriptor subPath encodes the nodeId so the runner can load context
    expect(
      planTemplate?.container?.volumeMounts?.find(
        (vm) => vm.mountPath === "/etc/pipeline/task.json"
      )?.subPath
    ).toBe("node-plan.json");
    expect(
      implTemplate?.container?.volumeMounts?.find(
        (vm) => vm.mountPath === "/etc/pipeline/task.json"
      )?.subPath
    ).toBe("node-impl.json");
    // schedule payload is mounted — runner loads agent profile from it via nodeId
    expect(
      planTemplate?.container?.volumeMounts?.some(
        (vm) => vm.mountPath === "/etc/pipeline/schedule.yaml"
      )
    ).toBe(true);
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

// ---------------------------------------------------------------------------
// compileArgoExecutionGraph — graph lowering semantics
// ---------------------------------------------------------------------------

function agentConfig() {
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
  impl:
    runner: opencode
    instructions: { inline: Implement }
  review:
    runner: opencode
    instructions: { inline: Review }
`,
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes: []
`,
  });
}

describe("compileArgoExecutionGraph", () => {
  it("lowers agent-kind nodes to Argo DAG tasks with preserved dependency order", () => {
    const config = agentConfig();
    config.workflows["agent-dag"] = {
      nodes: [
        { id: "plan", kind: "agent", profile: "orchestrator" },
        { id: "impl", kind: "agent", profile: "impl", needs: ["plan"] },
        { id: "review", kind: "agent", profile: "review", needs: ["impl"] },
      ],
    };
    const agentPlan = compileWorkflowPlan(config, "agent-dag");
    const graph = compileArgoExecutionGraph(agentPlan);

    expect(graph.tasks.map((t) => t.nodeId)).toEqual([
      "plan",
      "impl",
      "review",
    ]);
    expect(graph.tasks.find((t) => t.nodeId === "impl")?.dependencies).toEqual([
      "node-plan",
    ]);
    expect(
      graph.tasks.find((t) => t.nodeId === "review")?.dependencies
    ).toEqual(["node-impl"]);
    expect(graph.terminalNodeIds).toEqual(["review"]);
    expect(graph.terminalTaskNames).toEqual(["node-review"]);
  });

  it("lowers builtin-kind nodes to Argo DAG tasks", () => {
    const config = agentConfig();
    config.workflows["builtin-dag"] = {
      nodes: [
        { id: "lint", kind: "builtin", builtin: "lint" },
        { id: "test", kind: "builtin", builtin: "test", needs: ["lint"] },
      ],
    };
    const builtinPlan = compileWorkflowPlan(config, "builtin-dag");
    const graph = compileArgoExecutionGraph(builtinPlan);

    expect(graph.tasks.map((t) => t.nodeId)).toEqual(["lint", "test"]);
    expect(graph.tasks.find((t) => t.nodeId === "test")?.dependencies).toEqual([
      "node-lint",
    ]);
  });

  it("fans out agent nodes from a shared upstream and fans back in to a terminal", () => {
    /*
     * fan-out/fan-in shape:
     *   start → [impl-a, impl-b] → review
     */
    const config = agentConfig();
    config.workflows["fan-graph"] = {
      nodes: [
        { id: "start", kind: "agent", profile: "orchestrator" },
        { id: "impl-a", kind: "agent", profile: "impl", needs: ["start"] },
        { id: "impl-b", kind: "agent", profile: "impl", needs: ["start"] },
        {
          id: "review",
          kind: "agent",
          profile: "review",
          needs: ["impl-a", "impl-b"],
        },
      ],
    };
    const fanPlan = compileWorkflowPlan(config, "fan-graph");
    const graph = compileArgoExecutionGraph(fanPlan);

    const taskDeps = Object.fromEntries(
      graph.tasks.map((t) => [t.nodeId, t.dependencies])
    );
    expect(taskDeps.start).toEqual([]);
    expect(taskDeps["impl-a"]).toEqual(["node-start"]);
    expect(taskDeps["impl-b"]).toEqual(["node-start"]);
    expect(taskDeps.review).toEqual(
      expect.arrayContaining(["node-impl-a", "node-impl-b"])
    );
    // fan-in: review is the only terminal
    expect(graph.terminalNodeIds).toEqual(["review"]);
  });

  it("lowers a parallel container: children inherit the parallel node's needs", () => {
    /*
     * AC#3: parallel containers are transparent — children are emitted as
     * direct Argo tasks, each inheriting the parallel node's own needs so that
     * they are blocked by the same upstream gate as the container itself.
     *
     * Layout:  gate → [parallel: [child-a, child-b]] → (children are terminal)
     */
    const config = agentConfig();
    config.workflows["parallel-graph"] = {
      nodes: [
        { id: "gate", kind: "command", command: ["true"] },
        {
          id: "fanout",
          kind: "parallel",
          needs: ["gate"],
          nodes: [
            {
              id: "child-a",
              kind: "agent",
              profile: "impl",
            },
            {
              id: "child-b",
              kind: "agent",
              profile: "review",
            },
          ],
        },
      ],
    };
    const parallelPlan = compileWorkflowPlan(config, "parallel-graph");
    const graph = compileArgoExecutionGraph(parallelPlan);

    // parallel container itself produces no task — only its children do
    expect(graph.tasks.map((t) => t.nodeId)).toEqual([
      "gate",
      "child-a",
      "child-b",
    ]);
    // children inherit the parallel node's need (gate)
    expect(
      graph.tasks.find((t) => t.nodeId === "child-a")?.dependencies
    ).toEqual(["node-gate"]);
    expect(
      graph.tasks.find((t) => t.nodeId === "child-b")?.dependencies
    ).toEqual(["node-gate"]);
    // both children are terminal (nothing depends on them)
    expect(graph.terminalNodeIds).toEqual(
      expect.arrayContaining(["child-a", "child-b"])
    );
  });

  it("rewires dependencies through a group node to its executable members", () => {
    /*
     * AC#3: group nodes are transparent dependency anchors. A node that needs
     * a group should end up depending on the group's member nodes in the Argo
     * DAG rather than the group itself (which produces no Argo task).
     *
     * Layout:  [impl-a, impl-b] → group → review
     * Expected Argo deps for review: [node-impl-a, node-impl-b]
     */
    const config = agentConfig();
    config.workflows["group-graph"] = {
      nodes: [
        { id: "impl-a", kind: "agent", profile: "impl" },
        { id: "impl-b", kind: "agent", profile: "impl" },
        {
          id: "impls",
          kind: "group",
          nodes: ["impl-a", "impl-b"],
        },
        {
          id: "review",
          kind: "agent",
          profile: "review",
          needs: ["impls"],
        },
      ],
    };
    const groupPlan = compileWorkflowPlan(config, "group-graph");
    const graph = compileArgoExecutionGraph(groupPlan);

    // group produces no Argo task
    expect(graph.tasks.map((t) => t.nodeId)).toEqual([
      "impl-a",
      "impl-b",
      "review",
    ]);
    // review is rewired to the group's members
    expect(
      graph.tasks.find((t) => t.nodeId === "review")?.dependencies
    ).toEqual(expect.arrayContaining(["node-impl-a", "node-impl-b"]));
    expect(graph.terminalNodeIds).toEqual(["review"]);
  });

  it("ArgoGraphCompilerError names both kind and nodeId for diagnostics", () => {
    /*
     * The exhaustiveness guard in compileNode produces an ArgoGraphCompilerError
     * that names both the unknown kind and the node id so operators can diagnose
     * which schedule item caused the failure. Since all current WorkflowNodeKind
     * values are handled, we construct a synthetic PlannedWorkflowNode with a
     * fabricated kind to exercise the error path.
     */
    const err = new ArgoGraphCompilerError("unknown-kind", "node-xyz");
    expect(err).toBeInstanceOf(ArgoGraphCompilerError);
    expect(err.name).toBe("ArgoGraphCompilerError");
    expect(err.kind).toBe("unknown-kind");
    expect(err.nodeId).toBe("node-xyz");
    expect(err.message).toContain("unknown-kind");
    expect(err.message).toContain("node-xyz");
  });
});
