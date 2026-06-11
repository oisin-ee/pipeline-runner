import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildCommandScheduleYaml,
  submitRunnerArgoWorkflow,
} from "../src/argo-submit";
import { loadPipelineConfig } from "../src/config";
import { parseScheduleArtifact } from "../src/schedule-planner";

const DEFAULT_PROJECT = mkdtempSync(join(tmpdir(), "argo-submit-"));
const DEFAULT_CONFIG = loadPipelineConfig(DEFAULT_PROJECT);
const PAYLOAD_CONFIG_MAP_RE = /^pipeline-payload-/;
const SCHEDULE_CONFIG_MAP_RE = /^pipeline-schedule-/;
const TASK_DESCRIPTOR_CONFIG_MAP_RE = /^pipeline-task-descriptors-/;

afterAll(() => {
  rmSync(DEFAULT_PROJECT, { force: true, recursive: true });
});

const SCHEDULE = `
kind: pipeline-schedule
version: 1
schedule_id: submit-smoke
generated_at: 2026-06-10T00:00:00.000Z
source_entrypoint: quick
task: Submit smoke
root_workflow: root
workflows:
  root:
    nodes:
      - id: one
        kind: command
        command: ["echo", "one"]
      - id: two
        kind: command
        command: ["echo", "two"]
        needs: ["one"]
`;

const PAYLOAD = JSON.stringify({
  contractVersion: "1",
  delivery: { pullRequest: false },
  events: {
    authHeader: "Authorization",
    authTokenFile: "/etc/pipeline/event-auth/token",
    url: "https://pipeline-console.example/api/pipeline/runner-events",
  },
  repository: {
    baseBranch: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/oisin-ee/rondo.git",
  },
  run: {
    id: "run-1",
    project: "rondo",
  },
  task: {
    kind: "prompt",
    prompt: "Submit smoke",
  },
  submission: {
    kind: "graph",
    mode: "quick",
  },
  workflow: {
    id: "schedule-submit-smoke-root",
  },
});

describe("submitRunnerArgoWorkflow", () => {
  it("creates payload and schedule ConfigMaps before submitting an Argo Workflow", async () => {
    const createdConfigMaps: unknown[] = [];
    const createdWorkflows: unknown[] = [];

    const result = await submitRunnerArgoWorkflow(
      {
        config: DEFAULT_CONFIG,
        eventAuthSecretKey: "token",
        eventAuthSecretName: "pipeline-runner-event-auth",
        generateName: "pipeline-run-",
        namespace: "momokaya-pipeline",
        payloadJson: PAYLOAD,
        queueName: "momokaya-pipeline",
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: {
          createNamespacedConfigMap(input) {
            createdConfigMaps.push(input.body);
            return Promise.resolve(input.body);
          },
        },
        workflowApi: {
          createNamespacedCustomObject(input) {
            createdWorkflows.push(input.body);
            return Promise.resolve({
              ...(input.body as Record<string, unknown>),
              metadata: {
                ...(input.body as { metadata: Record<string, unknown> })
                  .metadata,
                name: "pipeline-run-abcde",
                uid: "workflow-uid-1",
              },
            });
          },
        },
      }
    );

    expect(createdConfigMaps).toHaveLength(3);
    expect(createdWorkflows).toHaveLength(1);
    expect(createdConfigMaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: { "payload.json": PAYLOAD },
          kind: "ConfigMap",
        }),
        expect.objectContaining({
          data: { "schedule.yaml": SCHEDULE },
          kind: "ConfigMap",
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            "node-one.json": '{"nodeId":"one"}\n',
            "node-two.json": '{"nodeId":"two"}\n',
          }),
          kind: "ConfigMap",
        }),
      ])
    );
    expect(createdWorkflows[0]).toMatchObject({
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Workflow",
      metadata: {
        generateName: "pipeline-run-",
        labels: {
          "pipeline.oisin.dev/project": "rondo",
          "pipeline.oisin.dev/run-id": "run-1",
          "pipeline.oisin.dev/source": "argo-workflow",
        },
        namespace: "momokaya-pipeline",
      },
      spec: {
        podMetadata: {
          labels: { "kueue.x-k8s.io/queue-name": "momokaya-pipeline" },
        },
      },
    });
    expect(result).toEqual({
      namespace: "momokaya-pipeline",
      payloadConfigMapName: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
      scheduleConfigMapName: expect.stringMatching(SCHEDULE_CONFIG_MAP_RE),
      taskDescriptorConfigMapName: expect.stringMatching(
        TASK_DESCRIPTOR_CONFIG_MAP_RE
      ),
      workflowName: "pipeline-run-abcde",
      workflowUid: "workflow-uid-1",
    });
  });

  it("stores ticket metadata on submitted Argo Workflow annotations", async () => {
    const createdWorkflows: unknown[] = [];
    const payload = JSON.stringify({
      ...JSON.parse(PAYLOAD),
      task: {
        id: "RONDO-017.01",
        kind: "ticket",
        path: "backlog/tasks/task-RONDO-017.01.md",
        title: "Fix message persistence",
      },
    });

    await submitRunnerArgoWorkflow(
      {
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace: "momokaya-pipeline",
        payloadJson: payload,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: {
          createNamespacedConfigMap(input) {
            return Promise.resolve(input.body);
          },
        },
        workflowApi: {
          createNamespacedCustomObject(input) {
            createdWorkflows.push(input.body);
            return Promise.resolve({
              ...(input.body as Record<string, unknown>),
              metadata: {
                ...(input.body as { metadata: Record<string, unknown> })
                  .metadata,
                name: "pipeline-run-ticket",
                uid: "workflow-ticket-uid",
              },
            });
          },
        },
      }
    );

    expect(createdWorkflows[0]).toMatchObject({
      metadata: {
        annotations: {
          "pipeline.oisin.dev/ticket-id": "RONDO-017.01",
          "pipeline.oisin.dev/ticket-project": "rondo",
          "pipeline.oisin.dev/ticket-title": "Fix message persistence",
        },
        labels: {
          "pipeline.oisin.dev/project": "rondo",
          "pipeline.oisin.dev/run-id": "run-1",
          "pipeline.oisin.dev/source": "argo-workflow",
          "pipeline.oisin.dev/workflow": "schedule-submit-smoke-root",
        },
      },
    });
  });

  it("builds valid schedule YAML for a custom argv command", () => {
    const schedule = parseScheduleArtifact(
      buildCommandScheduleYaml({
        command: ["moka", "submit", "--quick", "ship it"],
        generatedAt: new Date("2026-06-10T01:02:03.000Z"),
        scheduleId: "custom-quick",
        task: "moka submit --quick ship it",
      })
    );

    expect(schedule).toMatchObject({
      generated_at: "2026-06-10T01:02:03.000Z",
      root_workflow: "root",
      schedule_id: "custom-quick",
      source_entrypoint: "custom",
      task: "moka submit --quick ship it",
      workflows: {
        root: {
          nodes: [
            {
              command: ["moka", "submit", "--quick", "ship it"],
              id: "command",
              kind: "command",
            },
          ],
        },
      },
    });
  });
});
