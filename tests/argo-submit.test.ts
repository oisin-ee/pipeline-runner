import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { V1ConfigMap } from "@kubernetes/client-node";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  buildCommandScheduleYaml,
  submitDynamicRunnerArgoWorkflow,
  submitRunnerArgoWorkflow,
} from "../src/argo-submit";
import { runnerArgoWorkflowManifestSchema } from "../src/argo-workflow";
import type { ArgoWorkflowManifest } from "../src/argo-workflow";
import { loadPipelineConfig, parsePipelineConfigParts } from "../src/config";
import { parseScheduleArtifact } from "../src/planning/generate";
import { parseWithSchema } from "../src/schema-boundary";

const DEFAULT_PROJECT = mkdtempSync(join(tmpdir(), "argo-submit-"));
const DEFAULT_CONFIG = loadPipelineConfig(DEFAULT_PROJECT, {
  allowMissingLintFileReferences: true,
});
const PAYLOAD_CONFIG_MAP_RE = /^pipeline-payload-/u;
const SCHEDULE_CONFIG_MAP_RE = /^pipeline-schedule-/u;
const TASK_DESCRIPTOR_CONFIG_MAP_RE = /^pipeline-task-descriptors-/u;
const BROKER_AUTH = {
  secretKey: "api-key",
  secretName: "broker-api-key",
  url: "https://cliproxy.momokaya.ee",
};
const WORKFLOW_OWNER_REFERENCE = {
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Workflow",
  name: "pipeline-run-abcde",
  uid: "workflow-uid-1",
};

interface PatchConfigMapRequest {
  readonly body: {
    readonly metadata: {
      readonly ownerReferences: readonly [typeof WORKFLOW_OWNER_REFERENCE];
    };
  };
  readonly name: string;
  readonly namespace: string;
}

interface DeleteConfigMapRequest {
  readonly name: string;
  readonly namespace: string;
}

interface ConfigMapApiOverrides {
  readonly createNamespacedConfigMap: (input: {
    readonly body: V1ConfigMap;
  }) => unknown;
  readonly deleteNamespacedConfigMap?: (
    input: DeleteConfigMapRequest
  ) => unknown;
  readonly patchNamespacedConfigMap?: (input: PatchConfigMapRequest) => unknown;
}

interface WorkflowApiInput {
  readonly body: unknown;
}

const configMapApi = (overrides: ConfigMapApiOverrides) => ({
  createNamespacedConfigMap: async (input: { readonly body: V1ConfigMap }) =>
    await Promise.resolve(overrides.createNamespacedConfigMap(input)),
  deleteNamespacedConfigMap: async (input: DeleteConfigMapRequest) =>
    await Promise.resolve(
      (
        overrides.deleteNamespacedConfigMap ??
        ((request: DeleteConfigMapRequest) => ({
          apiVersion: "v1",
          kind: "Status",
          metadata: { name: request.name },
        }))
      )(input)
    ),
  patchNamespacedConfigMap: async (input: PatchConfigMapRequest) =>
    await Promise.resolve(
      (
        overrides.patchNamespacedConfigMap ??
        ((request: PatchConfigMapRequest) => ({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: request.name,
            namespace: request.namespace,
            ownerReferences: request.body.metadata.ownerReferences,
          },
        }))
      )(input)
    ),
});

const customObjectsApi = (
  createNamespacedCustomObject: (input: WorkflowApiInput) => unknown
) => ({
  createNamespacedCustomObject: async (input: WorkflowApiInput) =>
    await Promise.resolve(createNamespacedCustomObject(input)),
});

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
  submission: {
    kind: "graph",
    mode: "quick",
  },
  task: {
    kind: "prompt",
    prompt: "Submit smoke",
  },
  workflow: {
    id: "schedule-submit-smoke-root",
  },
});

describe("submitRunnerArgoWorkflow", () => {
  const namespace = "workflow-namespace";

  it("creates payload and schedule ConfigMaps before submitting an Argo Workflow", async () => {
    const createdConfigMaps: unknown[] = [];
    const createdWorkflows: unknown[] = [];

    const result = await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        eventAuthSecretKey: "token",
        eventAuthSecretName: "pipeline-runner-event-auth",
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            createdConfigMaps.push(input.body);
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(input.body);
          return {
            ...(input.body as Record<string, unknown>),
            metadata: {
              ...(input.body as { metadata: Record<string, unknown> }).metadata,
              name: "pipeline-run-abcde",
              uid: "workflow-uid-1",
            },
          };
        }),
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
        namespace,
      },
      spec: {
        templates: expect.arrayContaining([
          expect.objectContaining({
            container: expect.objectContaining({
              args: expect.arrayContaining(["/etc/pipeline/schedule.yaml"]),
              volumeMounts: expect.arrayContaining([
                expect.objectContaining({
                  mountPath: "/etc/pipeline/schedule.yaml",
                  name: "runner-schedule",
                  readOnly: true,
                  subPath: "schedule.yaml",
                }),
              ]),
            }),
          }),
        ]),
        volumes: expect.arrayContaining([
          expect.objectContaining({
            configMap: {
              items: [{ key: "schedule.yaml", path: "schedule.yaml" }],
              name: expect.stringMatching(SCHEDULE_CONFIG_MAP_RE),
            },
            name: "runner-schedule",
          }),
        ]),
      },
    });
    expect(result).toEqual({
      namespace,
      payloadConfigMapName: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
      scheduleConfigMapName: expect.stringMatching(SCHEDULE_CONFIG_MAP_RE),
      taskDescriptorConfigMapName: expect.stringMatching(
        TASK_DESCRIPTOR_CONFIG_MAP_RE
      ),
      workflowName: "pipeline-run-abcde",
      workflowUid: "workflow-uid-1",
    });
  });

  it("patches static run ConfigMaps with ownerReferences after Workflow creation", async () => {
    const createdConfigMaps: V1ConfigMap[] = [];
    const patchedConfigMaps: PatchConfigMapRequest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input: { body: V1ConfigMap }) {
            createdConfigMaps.push(input.body);
            return input.body;
          },
          deleteNamespacedConfigMap(input: DeleteConfigMapRequest) {
            return { metadata: { name: input.name } };
          },
          patchNamespacedConfigMap(input: PatchConfigMapRequest) {
            patchedConfigMaps.push(input);
            return {
              metadata: {
                name: input.name,
                namespace: input.namespace,
                ownerReferences: input.body.metadata.ownerReferences,
              },
            };
          },
        }),
        workflowApi: customObjectsApi(() => ({
          metadata: {
            name: WORKFLOW_OWNER_REFERENCE.name,
            uid: WORKFLOW_OWNER_REFERENCE.uid,
          },
        })),
      }
    );

    const createdNames = createdConfigMaps.map(
      (configMap) => configMap.metadata?.name
    );
    expect(patchedConfigMaps).toHaveLength(3);
    expect(patchedConfigMaps.map((configMap) => configMap.name)).toEqual(
      expect.arrayContaining(createdNames)
    );
    expect(patchedConfigMaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: {
            metadata: { ownerReferences: [WORKFLOW_OWNER_REFERENCE] },
          },
          name: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
          namespace,
        }),
        expect.objectContaining({
          body: {
            metadata: { ownerReferences: [WORKFLOW_OWNER_REFERENCE] },
          },
          name: expect.stringMatching(SCHEDULE_CONFIG_MAP_RE),
          namespace,
        }),
        expect.objectContaining({
          body: {
            metadata: { ownerReferences: [WORKFLOW_OWNER_REFERENCE] },
          },
          name: expect.stringMatching(TASK_DESCRIPTOR_CONFIG_MAP_RE),
          namespace,
        }),
      ])
    );
  });

  it("patches dynamic run ConfigMap with ownerReferences after Workflow creation", async () => {
    const patchedConfigMaps: PatchConfigMapRequest[] = [];

    await submitDynamicRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        workflowId: "schedule-submit-smoke-root",
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input: { body: V1ConfigMap }) {
            return input.body;
          },
          deleteNamespacedConfigMap(input: DeleteConfigMapRequest) {
            return { metadata: { name: input.name } };
          },
          patchNamespacedConfigMap(input: PatchConfigMapRequest) {
            patchedConfigMaps.push(input);
            return {
              metadata: {
                name: input.name,
                namespace: input.namespace,
                ownerReferences: input.body.metadata.ownerReferences,
              },
            };
          },
        }),
        workflowApi: customObjectsApi(() => ({
          metadata: {
            name: WORKFLOW_OWNER_REFERENCE.name,
            uid: WORKFLOW_OWNER_REFERENCE.uid,
          },
        })),
      }
    );

    expect(patchedConfigMaps).toHaveLength(1);
    expect(patchedConfigMaps[0]).toEqual({
      body: {
        metadata: { ownerReferences: [WORKFLOW_OWNER_REFERENCE] },
      },
      name: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
      namespace,
    });
  });

  it(
    "returns submitted Workflow result and keeps ConfigMaps when " +
      "ownerReference patching fails after Workflow creation",
    async () => {
      const deletedConfigMaps: DeleteConfigMapRequest[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      try {
        const result = await submitRunnerArgoWorkflow(
          {
            brokerAuth: BROKER_AUTH,
            config: DEFAULT_CONFIG,
            generateName: "pipeline-run-",
            namespace,
            payloadJson: PAYLOAD,
            scheduleYaml: SCHEDULE,
          },
          {
            coreApi: configMapApi({
              createNamespacedConfigMap(input: { body: V1ConfigMap }) {
                return input.body;
              },
              deleteNamespacedConfigMap(input: DeleteConfigMapRequest) {
                deletedConfigMaps.push(input);
                return { metadata: { name: input.name } };
              },
              patchNamespacedConfigMap() {
                throw new Error("patch failed");
              },
            }),
            workflowApi: customObjectsApi(() => ({
              metadata: {
                name: WORKFLOW_OWNER_REFERENCE.name,
                uid: WORKFLOW_OWNER_REFERENCE.uid,
              },
            })),
          }
        );

        expect(result).toEqual({
          namespace,
          payloadConfigMapName: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
          scheduleConfigMapName: expect.stringMatching(SCHEDULE_CONFIG_MAP_RE),
          taskDescriptorConfigMapName: expect.stringMatching(
            TASK_DESCRIPTOR_CONFIG_MAP_RE
          ),
          workflowName: WORKFLOW_OWNER_REFERENCE.name,
          workflowUid: WORKFLOW_OWNER_REFERENCE.uid,
        });
        expect(deletedConfigMaps).toEqual([]);
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            "moka submit: failed to set Workflow ownerReference"
          )
        );
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("patch failed")
        );
      } finally {
        stderrSpy.mockRestore();
      }
    }
  );

  it("deletes created ConfigMaps when Workflow creation fails before Workflow exists", async () => {
    const deletedConfigMaps: DeleteConfigMapRequest[] = [];
    const patchedConfigMaps: PatchConfigMapRequest[] = [];

    await expect(
      submitRunnerArgoWorkflow(
        {
          brokerAuth: BROKER_AUTH,
          config: DEFAULT_CONFIG,
          generateName: "pipeline-run-",
          namespace,
          payloadJson: PAYLOAD,
          scheduleYaml: SCHEDULE,
        },
        {
          coreApi: configMapApi({
            createNamespacedConfigMap(input: { body: V1ConfigMap }) {
              return input.body;
            },
            deleteNamespacedConfigMap(input: DeleteConfigMapRequest) {
              deletedConfigMaps.push(input);
              return { metadata: { name: input.name } };
            },
            patchNamespacedConfigMap(input: PatchConfigMapRequest) {
              patchedConfigMaps.push(input);
              return {
                metadata: {
                  name: input.name,
                  namespace: input.namespace,
                  ownerReferences: input.body.metadata.ownerReferences,
                },
              };
            },
          }),
          workflowApi: customObjectsApi(() => {
            throw new Error("workflow create failed");
          }),
        }
      )
    ).rejects.toThrow("workflow create failed");

    expect(patchedConfigMaps).toEqual([]);
    expect(deletedConfigMaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
          namespace,
        }),
        expect.objectContaining({
          name: expect.stringMatching(SCHEDULE_CONFIG_MAP_RE),
          namespace,
        }),
        expect.objectContaining({
          name: expect.stringMatching(TASK_DESCRIPTOR_CONFIG_MAP_RE),
          namespace,
        }),
      ])
    );
  });

  it("returns submitted Workflow result and skips ownership when Workflow response has no uid", async () => {
    const deletedConfigMaps: DeleteConfigMapRequest[] = [];
    const patchedConfigMaps: PatchConfigMapRequest[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const result = await submitDynamicRunnerArgoWorkflow(
        {
          brokerAuth: BROKER_AUTH,
          config: DEFAULT_CONFIG,
          generateName: "pipeline-run-",
          namespace,
          payloadJson: PAYLOAD,
          workflowId: "schedule-submit-smoke-root",
        },
        {
          coreApi: configMapApi({
            createNamespacedConfigMap(input: { body: V1ConfigMap }) {
              return input.body;
            },
            deleteNamespacedConfigMap(input: DeleteConfigMapRequest) {
              deletedConfigMaps.push(input);
              return { metadata: { name: input.name } };
            },
            patchNamespacedConfigMap(input: PatchConfigMapRequest) {
              patchedConfigMaps.push(input);
              return {
                metadata: {
                  name: input.name,
                  namespace: input.namespace,
                  ownerReferences: input.body.metadata.ownerReferences,
                },
              };
            },
          }),
          workflowApi: customObjectsApi(() => ({
            metadata: {
              name: WORKFLOW_OWNER_REFERENCE.name,
            },
          })),
        }
      );

      expect(result).toEqual({
        namespace,
        payloadConfigMapName: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
        workflowName: WORKFLOW_OWNER_REFERENCE.name,
      });
      expect(deletedConfigMaps).toEqual([]);
      expect(patchedConfigMaps).toEqual([]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("did not include metadata.uid")
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("normalizes GitHub SSH repository URLs in persisted runner payloads", async () => {
    const createdConfigMaps: {
      data?: Record<string, string>;
      metadata?: { name?: string };
    }[] = [];
    const payload = JSON.stringify({
      ...JSON.parse(PAYLOAD),
      repository: {
        baseBranch: "main",
        sha: "0123456789abcdef0123456789abcdef01234567",
        url: "git@github.com:oisin-ee/rondo.git",
      },
    });

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        eventAuthSecretKey: "token",
        eventAuthSecretName: "pipeline-runner-event-auth",
        generateName: "pipeline-run-",
        namespace,
        payloadJson: payload,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            createdConfigMaps.push(input.body);
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => ({
          ...(input.body as Record<string, unknown>),
          metadata: {
            ...(input.body as { metadata: Record<string, unknown> }).metadata,
            name: "pipeline-run-normalized",
            uid: "workflow-normalized-uid",
          },
        })),
      }
    );

    const payloadConfigMap = createdConfigMaps.find(
      (configMap) =>
        configMap.metadata?.name?.startsWith("pipeline-payload-") === true
    );
    const payloadJson = payloadConfigMap?.data?.["payload.json"];
    expect(payloadJson).toBeDefined();
    if (payloadJson === undefined || payloadJson.length === 0) {
      throw new Error("Expected payload ConfigMap to include payload.json");
    }
    const persistedPayload = JSON.parse(payloadJson);
    expect(persistedPayload.repository.url).toBe(
      "https://github.com/oisin-ee/rondo.git"
    );
  });

  it("threads caller-supplied Workflow retention, deadline, and pod GC into static submissions", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        activeDeadlineSeconds: 3600,
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        podGC: {
          deleteDelayDuration: "30s",
          strategy: "OnPodSuccess",
        },
        scheduleYaml: SCHEDULE,
        ttlStrategy: {
          secondsAfterFailure: 604_800,
          secondsAfterSuccess: 300,
        },
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-lifecycle",
              uid: "workflow-lifecycle-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    expect(createdWorkflows[0].spec).toMatchObject({
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

  it("threads caller-supplied Workflow retention, deadline, and pod GC into dynamic submissions", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitDynamicRunnerArgoWorkflow(
      {
        activeDeadlineSeconds: 3600,
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        podGC: {
          deleteDelayDuration: "30s",
          strategy: "OnPodSuccess",
        },
        ttlStrategy: {
          secondsAfterFailure: 604_800,
          secondsAfterSuccess: 300,
        },
        workflowId: "schedule-submit-smoke-root",
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-dynamic-lifecycle",
              uid: "workflow-dynamic-lifecycle-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    expect(createdWorkflows[0].spec).toMatchObject({
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

  it("omits Workflow retention, deadline, and pod GC when caller leaves them unset", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-no-lifecycle",
              uid: "workflow-no-lifecycle-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    expect(createdWorkflows[0].spec).not.toHaveProperty(
      "activeDeadlineSeconds"
    );
    expect(createdWorkflows[0].spec).not.toHaveProperty("podGC");
    expect(createdWorkflows[0].spec).not.toHaveProperty("ttlStrategy");
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
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: payload,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(input.body);
          return {
            ...(input.body as Record<string, unknown>),
            metadata: {
              ...(input.body as { metadata: Record<string, unknown> }).metadata,
              name: "pipeline-run-ticket",
              uid: "workflow-ticket-uid",
            },
          };
        }),
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

  // PIPE-94.4: AC3 — dbAuth threads end-to-end into runner container env
  it("injects MOKA_DB_URL secretKeyRef into runner container env when dbAuth is configured (AC3)", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        dbAuth: { secretKey: "db-url", secretName: "momokaya-db" },
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          // Parse through the manifest schema — type-safe, no casts.
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-dbauth",
              uid: "workflow-dbauth-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    const containerTemplates = createdWorkflows[0].spec.templates.filter(
      (t) => t.container !== undefined
    );
    expect(containerTemplates.length).toBeGreaterThan(0);
    for (const template of containerTemplates) {
      expect(template.container?.env).toContainEqual({
        name: "MOKA_DB_URL",
        valueFrom: { secretKeyRef: { key: "db-url", name: "momokaya-db" } },
      });
    }
  });

  it("omits MOKA_DB_URL env var from runner container env when dbAuth is absent (AC3 absence)", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-no-dbauth",
              uid: "workflow-no-dbauth-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    for (const template of createdWorkflows[0].spec.templates) {
      const env = template.container?.env ?? [];
      expect(env).not.toContainEqual(
        expect.objectContaining({ name: "MOKA_DB_URL" })
      );
    }
  });

  it("injects PIPELINE_MCP_GATEWAY_AUTHORIZATION secretKeyRef into runner container env when mcpGatewayAuth is configured", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        mcpGatewayAuth: {
          secretKey: "pipeline-mcp-gateway-authorization",
          secretName: "pipeline-runner-mcp-auth",
        },
        namespace,
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-mcpgateway",
              uid: "workflow-mcpgateway-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    const containerTemplates = createdWorkflows[0].spec.templates.filter(
      (t) => t.container !== undefined
    );
    expect(containerTemplates.length).toBeGreaterThan(0);
    for (const template of containerTemplates) {
      expect(template.container?.env).toContainEqual({
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

  it("omits PIPELINE_MCP_GATEWAY_AUTHORIZATION env var from runner container env when mcpGatewayAuth is absent", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-no-mcpgateway",
              uid: "workflow-no-mcpgateway-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    for (const template of createdWorkflows[0].spec.templates) {
      const env = template.container?.env ?? [];
      expect(env).not.toContainEqual(
        expect.objectContaining({ name: "PIPELINE_MCP_GATEWAY_AUTHORIZATION" })
      );
    }
  });

  it("injects PIPELINE_MCP_GATEWAY_AUTHORIZATION into dynamic runner containers when mcpGatewayAuth is configured", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitDynamicRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        mcpGatewayAuth: {
          secretKey: "pipeline-mcp-gateway-authorization",
          secretName: "pipeline-runner-mcp-auth",
        },
        namespace,
        payloadJson: PAYLOAD,
        workflowId: "schedule-submit-smoke-root",
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-dynamic-mcpgateway",
              uid: "workflow-dynamic-mcpgateway-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    const containerTemplates = createdWorkflows[0].spec.templates.filter(
      (t) => t.container !== undefined
    );
    expect(containerTemplates.length).toBeGreaterThan(0);
    for (const template of containerTemplates) {
      expect(template.container?.env).toContainEqual({
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

  it("mounts an .npmrc Secret into static runner containers when npmRegistryAuthSecretName is configured", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        npmRegistryAuthSecretName: "npm-registry-auth",
        payloadJson: PAYLOAD,
        scheduleYaml: SCHEDULE,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-npm-registry",
              uid: "workflow-npm-registry-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    expect(createdWorkflows[0].spec.volumes).toContainEqual(
      expect.objectContaining({
        name: "npm-registry-auth",
        secret: expect.objectContaining({ secretName: "npm-registry-auth" }),
      })
    );
    const containerTemplates = createdWorkflows[0].spec.templates.filter(
      (t) => t.container !== undefined
    );
    expect(containerTemplates.length).toBeGreaterThan(0);
    for (const template of containerTemplates) {
      expect(template.container?.volumeMounts).toContainEqual(
        expect.objectContaining({ mountPath: "/root/.npmrc" })
      );
    }
  });

  it("mounts an .npmrc Secret into dynamic runner containers when npmRegistryAuthSecretName is configured", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitDynamicRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        generateName: "pipeline-run-",
        namespace,
        npmRegistryAuthSecretName: "npm-registry-auth",
        payloadJson: PAYLOAD,
        workflowId: "schedule-submit-smoke-root",
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => {
          createdWorkflows.push(
            parseWithSchema(runnerArgoWorkflowManifestSchema, input.body)
          );
          return {
            metadata: {
              name: "pipeline-run-dynamic-npm-registry",
              uid: "workflow-dynamic-npm-registry-uid",
            },
          };
        }),
      }
    );

    expect(createdWorkflows).toHaveLength(1);
    expect(createdWorkflows[0].spec.volumes).toContainEqual(
      expect.objectContaining({
        name: "npm-registry-auth",
        secret: expect.objectContaining({ secretName: "npm-registry-auth" }),
      })
    );
    const containerTemplates = createdWorkflows[0].spec.templates.filter(
      (t) => t.container !== undefined
    );
    expect(containerTemplates.length).toBeGreaterThan(0);
    for (const template of containerTemplates) {
      expect(template.container?.volumeMounts).toContainEqual(
        expect.objectContaining({ mountPath: "/root/.npmrc" })
      );
    }
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

  it("omits the open-pull-request node by default", () => {
    const schedule = parseScheduleArtifact(
      buildCommandScheduleYaml({
        command: ["echo", "hi"],
        scheduleId: "custom-no-pr",
        task: "echo hi",
      })
    );

    const { nodes } = schedule.workflows.root;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("command");
  });

  it("appends an open-pull-request node depending on the command node when deliverPullRequest is set", () => {
    const schedule = parseScheduleArtifact(
      buildCommandScheduleYaml({
        command: ["echo", "hi"],
        deliverPullRequest: true,
        scheduleId: "custom-with-pr",
        task: "echo hi",
      })
    );

    const { nodes } = schedule.workflows.root;
    expect(nodes).toHaveLength(2);
    const prNode = nodes.find(
      (n) => n.kind === "builtin" && n.builtin === "open-pull-request"
    );
    expect(prNode).toBeDefined();
    expect(prNode?.needs).toEqual(["command"]);
  });

  it("submits a generated agent-node schedule: task descriptors carry nodeId per task", async () => {
    /*
     * AC#2: The runner recovers per-node agent context (profile, models,
     * instructions) from the compiled schedule artifact by nodeId at execution
     * time. The task descriptor ConfigMap therefore only needs to encode nodeId.
     * This test verifies that the uniform descriptor shape is correct for
     * agent-kind nodes.
     */
    const config = parsePipelineConfigParts({
      pipeline: `
version: 1
default_workflow: root
orchestrator:
  profile: orchestrator
workflows:
  root:
    nodes:
      - id: plan
        kind: agent
        profile: orchestrator
      - id: impl
        kind: agent
        profile: impl
        needs: [plan]
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

    const agentSchedule = `
kind: pipeline-schedule
version: 1
schedule_id: agent-test
generated_at: 2026-06-10T00:00:00.000Z
source_entrypoint: execute
task: Build the feature
root_workflow: root
workflows:
  root:
    nodes:
      - id: plan
        kind: agent
        profile: orchestrator
      - id: impl
        kind: agent
        profile: impl
        needs: [plan]
`;
    const payload = JSON.stringify({
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
      run: { id: "run-agent", project: "rondo" },
      submission: { kind: "graph", mode: "full" },
      task: { kind: "prompt", prompt: "Build the feature" },
      workflow: { id: "schedule-agent-test-root" },
    });

    const createdConfigMaps: { data?: Record<string, string> }[] = [];
    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config,
        generateName: "moka-full-",
        namespace,
        payloadJson: payload,
        scheduleYaml: agentSchedule,
      },
      {
        coreApi: configMapApi({
          createNamespacedConfigMap(input) {
            createdConfigMaps.push(input.body);
            return input.body;
          },
        }),
        workflowApi: customObjectsApi((input) => ({
          ...(input.body as Record<string, unknown>),
          metadata: {
            ...(input.body as { metadata: Record<string, unknown> }).metadata,
            name: "moka-full-agent",
            uid: "workflow-moka-full-agent-uid",
          },
        })),
      }
    );

    const descriptorConfigMap = createdConfigMaps.find((cm) =>
      Object.keys(cm.data ?? {}).some((key) => key.startsWith("node-"))
    );
    expect(descriptorConfigMap?.data).toMatchObject({
      "node-impl.json": '{"nodeId":"impl"}\n',
      // nodeId-only descriptors: runner loads agent profile from schedule
      "node-plan.json": '{"nodeId":"plan"}\n',
    });
  });
});
