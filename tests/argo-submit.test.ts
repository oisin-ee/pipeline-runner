import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildCommandScheduleYaml,
  submitRunnerArgoWorkflow,
} from "../src/argo-submit";
import {
  type ArgoWorkflowManifest,
  runnerArgoWorkflowManifestSchema,
} from "../src/argo-workflow";
import { loadPipelineConfig, parsePipelineConfigParts } from "../src/config";
import { parseScheduleArtifact } from "../src/planning/generate";

const DEFAULT_PROJECT = mkdtempSync(join(tmpdir(), "argo-submit-"));
const DEFAULT_CONFIG = loadPipelineConfig(DEFAULT_PROJECT, {
  allowMissingLintFileReferences: true,
});
const PAYLOAD_CONFIG_MAP_RE = /^pipeline-payload-/;
const SCHEDULE_CONFIG_MAP_RE = /^pipeline-schedule-/;
const TASK_DESCRIPTOR_CONFIG_MAP_RE = /^pipeline-task-descriptors-/;
const BROKER_AUTH = {
  secretKey: "api-key",
  secretName: "broker-api-key",
  url: "https://cliproxy.momokaya.ee",
};

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

  it("normalizes GitHub SSH repository URLs in persisted runner payloads", async () => {
    const createdConfigMaps: Array<{
      data?: Record<string, string>;
      metadata?: { name?: string };
    }> = [];
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
        coreApi: {
          createNamespacedConfigMap(input) {
            createdConfigMaps.push(input.body);
            return Promise.resolve(input.body);
          },
        },
        workflowApi: {
          createNamespacedCustomObject(input) {
            return Promise.resolve({
              ...(input.body as Record<string, unknown>),
              metadata: {
                ...(input.body as { metadata: Record<string, unknown> })
                  .metadata,
                name: "pipeline-run-normalized",
              },
            });
          },
        },
      }
    );

    const payloadConfigMap = createdConfigMaps.find((configMap) =>
      configMap.metadata?.name?.startsWith("pipeline-payload-")
    );
    const payloadJson = payloadConfigMap?.data?.["payload.json"];
    expect(payloadJson).toBeDefined();
    if (!payloadJson) {
      throw new Error("Expected payload ConfigMap to include payload.json");
    }
    const persistedPayload = JSON.parse(payloadJson);
    expect(persistedPayload.repository.url).toBe(
      "https://github.com/oisin-ee/rondo.git"
    );
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

  // PIPE-94.4: AC3 — dbAuth threads end-to-end into runner container env
  it("injects MOKA_DB_URL secretKeyRef into runner container env when dbAuth is configured (AC3)", async () => {
    const createdWorkflows: ArgoWorkflowManifest[] = [];

    await submitRunnerArgoWorkflow(
      {
        brokerAuth: BROKER_AUTH,
        config: DEFAULT_CONFIG,
        dbAuth: { secretName: "momokaya-db", secretKey: "db-url" },
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
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
            // Parse through the manifest schema — type-safe, no casts.
            createdWorkflows.push(
              runnerArgoWorkflowManifestSchema.parse(input.body)
            );
            return Promise.resolve({
              metadata: { name: "pipeline-run-dbauth" },
            });
          },
        },
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
        coreApi: {
          createNamespacedConfigMap(input) {
            return Promise.resolve(input.body);
          },
        },
        workflowApi: {
          createNamespacedCustomObject(input) {
            createdWorkflows.push(
              runnerArgoWorkflowManifestSchema.parse(input.body)
            );
            return Promise.resolve({
              metadata: { name: "pipeline-run-no-dbauth" },
            });
          },
        },
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
        mcpGatewayAuth: {
          secretName: "pipeline-runner-mcp-auth",
          secretKey: "pipeline-mcp-gateway-authorization",
        },
        generateName: "pipeline-run-",
        namespace,
        payloadJson: PAYLOAD,
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
            createdWorkflows.push(
              runnerArgoWorkflowManifestSchema.parse(input.body)
            );
            return Promise.resolve({
              metadata: { name: "pipeline-run-mcpgateway" },
            });
          },
        },
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
        coreApi: {
          createNamespacedConfigMap(input) {
            return Promise.resolve(input.body);
          },
        },
        workflowApi: {
          createNamespacedCustomObject(input) {
            createdWorkflows.push(
              runnerArgoWorkflowManifestSchema.parse(input.body)
            );
            return Promise.resolve({
              metadata: { name: "pipeline-run-no-mcpgateway" },
            });
          },
        },
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

  it("submits a generated agent-node schedule: task descriptors carry nodeId per task", async () => {
    /*
     * AC#2: The runner recovers per-node agent context (profile, models,
     * instructions) from the compiled schedule artifact by nodeId at execution
     * time. The task descriptor ConfigMap therefore only needs to encode nodeId.
     * This test verifies that the uniform descriptor shape is correct for
     * agent-kind nodes.
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

    const createdConfigMaps: Array<{ data?: Record<string, string> }> = [];
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
        coreApi: {
          createNamespacedConfigMap(input) {
            createdConfigMaps.push(input.body);
            return Promise.resolve(input.body);
          },
        },
        workflowApi: {
          createNamespacedCustomObject(input) {
            return Promise.resolve({
              ...(input.body as Record<string, unknown>),
              metadata: {
                ...(input.body as { metadata: Record<string, unknown> })
                  .metadata,
                name: "moka-full-agent",
              },
            });
          },
        },
      }
    );

    const descriptorConfigMap = createdConfigMaps.find((cm) =>
      Object.keys(cm.data ?? {}).some((key) => key.startsWith("node-"))
    );
    expect(descriptorConfigMap?.data).toMatchObject({
      // nodeId-only descriptors: runner loads agent profile from schedule
      "node-plan.json": '{"nodeId":"plan"}\n',
      "node-impl.json": '{"nodeId":"impl"}\n',
    });
  });
});
