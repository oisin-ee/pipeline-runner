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

const STARTUP_ONLY_RETRY_STRATEGY = {
  expression: "asInt(lastRetry.exitCode) == 70",
  limit: "3",
  retryPolicy: "OnFailure",
};

const STARTUP_RETRY_STRATEGY_FRAGMENT_PATTERN =
  /retryStrategy:\n\s+expression: asInt\(lastRetry\.exitCode\) == 70\n\s+limit: "3"\n\s+retryPolicy: OnFailure/;

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
      opencodeAuthSecretName: "opencode-auth-secret",
      plan: plan(),
      queueName: "pipeline-queue",
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
          "podMetadata": {
            "labels": {
              "kueue.x-k8s.io/queue-name": "pipeline-queue",
            },
          },
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
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
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
                    "mountPath": "/root/.local/share/opencode/auth.json",
                    "name": "opencode-auth",
                    "readOnly": true,
                    "subPath": "auth.json",
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
                "expression": "asInt(lastRetry.exitCode) == 70",
                "limit": "3",
                "retryPolicy": "OnFailure",
              },
            },
            {
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
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
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
                    "mountPath": "/root/.local/share/opencode/auth.json",
                    "name": "opencode-auth",
                    "readOnly": true,
                    "subPath": "auth.json",
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
                "expression": "asInt(lastRetry.exitCode) == 70",
                "limit": "3",
                "retryPolicy": "OnFailure",
              },
            },
            {
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
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
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
                    "mountPath": "/root/.local/share/opencode/auth.json",
                    "name": "opencode-auth",
                    "readOnly": true,
                    "subPath": "auth.json",
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
                "expression": "asInt(lastRetry.exitCode) == 70",
                "limit": "3",
                "retryPolicy": "OnFailure",
              },
            },
            {
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
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
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
                    "mountPath": "/root/.local/share/opencode/auth.json",
                    "name": "opencode-auth",
                    "readOnly": true,
                    "subPath": "auth.json",
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
                "expression": "asInt(lastRetry.exitCode) == 70",
                "limit": "3",
                "retryPolicy": "OnFailure",
              },
            },
            {
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
                ],
                "image": "ghcr.io/oisin-ee/pipeline-runner:latest",
                "imagePullPolicy": "Always",
                "name": "runner",
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
                    "mountPath": "/root/.local/share/opencode/auth.json",
                    "name": "opencode-auth",
                    "readOnly": true,
                    "subPath": "auth.json",
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
              "name": "opencode-auth",
              "secret": {
                "defaultMode": 256,
                "items": [
                  {
                    "key": "auth.json",
                    "path": "auth.json",
                  },
                ],
                "secretName": "opencode-auth-secret",
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
        podMetadata:
          labels:
            kueue.x-k8s.io/queue-name: pipeline-queue
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
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
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
                - mountPath: /root/.local/share/opencode/auth.json
                  name: opencode-auth
                  readOnly: true
                  subPath: auth.json
                - mountPath: /etc/pipeline/git-credentials
                  name: runner-git-credentials
                  readOnly: true
                - mountPath: /root/.config/gh/hosts.yml
                  name: github-auth
                  readOnly: true
                  subPath: hosts.yml
            name: workflow-start
            retryStrategy:
              expression: asInt(lastRetry.exitCode) == 70
              limit: "3"
              retryPolicy: OnFailure
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
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
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
                - mountPath: /root/.local/share/opencode/auth.json
                  name: opencode-auth
                  readOnly: true
                  subPath: auth.json
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
            name: task-one
            retryStrategy:
              expression: asInt(lastRetry.exitCode) == 70
              limit: "3"
              retryPolicy: OnFailure
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
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
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
                - mountPath: /root/.local/share/opencode/auth.json
                  name: opencode-auth
                  readOnly: true
                  subPath: auth.json
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
            name: task-two
            retryStrategy:
              expression: asInt(lastRetry.exitCode) == 70
              limit: "3"
              retryPolicy: OnFailure
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
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
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
                - mountPath: /root/.local/share/opencode/auth.json
                  name: opencode-auth
                  readOnly: true
                  subPath: auth.json
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
            name: task-three
            retryStrategy:
              expression: asInt(lastRetry.exitCode) == 70
              limit: "3"
              retryPolicy: OnFailure
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
              image: ghcr.io/oisin-ee/pipeline-runner:latest
              imagePullPolicy: Always
              name: runner
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
                - mountPath: /root/.local/share/opencode/auth.json
                  name: opencode-auth
                  readOnly: true
                  subPath: auth.json
                - mountPath: /etc/pipeline/git-credentials
                  name: runner-git-credentials
                  readOnly: true
                - mountPath: /root/.config/gh/hosts.yml
                  name: github-auth
                  readOnly: true
                  subPath: hosts.yml
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
          - name: opencode-auth
            secret:
              defaultMode: 256
              items:
                - key: auth.json
                  path: auth.json
              secretName: opencode-auth-secret
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

  it("retries runner startup failures only when Argo sees exit code 70", () => {
    const manifest = buildRunnerArgoWorkflowManifest({
      ...BASE_OPTIONS,
      plan: plan(),
    });

    expect(retryStrategyForTemplate(manifest, "workflow-start")).toEqual(
      STARTUP_ONLY_RETRY_STRATEGY
    );
    expect(retryStrategyForTemplate(manifest, "task-one")).toEqual(
      STARTUP_ONLY_RETRY_STRATEGY
    );
    expect(retryStrategyForTemplate(manifest, "task-two")).toEqual(
      STARTUP_ONLY_RETRY_STRATEGY
    );
    expect(retryStrategyForTemplate(manifest, "task-three")).toEqual(
      STARTUP_ONLY_RETRY_STRATEGY
    );
    expect(
      retryStrategyForTemplate(manifest, "pipeline-finalizer")
    ).toBeUndefined();

    const rendered = stringifyRunnerArgoWorkflow(manifest);
    expect(rendered).toContain("retryStrategy:\n");
    expect(rendered).toContain("expression: asInt(lastRetry.exitCode) == 70");
    expect(
      rendered.match(STARTUP_RETRY_STRATEGY_FRAGMENT_PATTERN)?.[0]
    ).toMatchInlineSnapshot(`
        "retryStrategy:
                expression: asInt(lastRetry.exitCode) == 70
                limit: "3"
                retryPolicy: OnFailure"
      `);
    expect(rendered).not.toContain("lastRetry.exitCode) == 1");
    expect(rendered).not.toContain("lastRetry.exitCode) == 64");
    const finalizerTemplate = rendered.slice(
      rendered.indexOf("name: pipeline-finalizer"),
      rendered.indexOf("\n  volumes:")
    );
    expect(finalizerTemplate).not.toContain("retryStrategy:");
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
            ? { ...template, retryStrategy: STARTUP_ONLY_RETRY_STRATEGY }
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
