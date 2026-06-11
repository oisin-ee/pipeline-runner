import { stringify } from "yaml";
import { z } from "zod";
import {
  type ArgoExecutableTask,
  compileArgoExecutionGraph,
} from "./argo-graph";
import { DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH } from "./runner-command/task-descriptor";
import type { WorkflowExecutionPlan } from "./workflow-planner";

const ARGO_WORKFLOW_API_VERSION = "argoproj.io/v1alpha1";
const ARGO_WORKFLOW_KIND = "Workflow";
const RUNNER_WORKFLOW_IMAGE = "ghcr.io/oisin-ee/pipeline-runner:latest";
const RUNNER_WORKFLOW_SERVICE_ACCOUNT = "pipeline-runner";
const RUNNER_WORKFLOW_ENTRYPOINT = "pipeline";
const RUNNER_WORKFLOW_PAYLOAD_PATH = "/etc/pipeline/payload.json";
const RUNNER_WORKFLOW_SCHEDULE_PATH = "/etc/pipeline/schedule.yaml";

const kubernetesNameSchema = z.string().min(1);
const labelValueSchema = z.string().min(1);
const stringMapSchema = z.record(z.string().min(1), z.string().min(1));

const configMapVolumeSchema = z
  .object({
    items: z.array(
      z.object({ key: z.string().min(1), path: z.string().min(1) }).strict()
    ),
    name: kubernetesNameSchema,
  })
  .strict();

const secretVolumeSchema = z
  .object({
    defaultMode: z.number().int().positive().optional(),
    items: z
      .array(
        z.object({ key: z.string().min(1), path: z.string().min(1) }).strict()
      )
      .optional(),
    secretName: kubernetesNameSchema,
  })
  .strict();

const argoWorkflowVolumeSchema = z
  .object({
    configMap: configMapVolumeSchema.optional(),
    name: kubernetesNameSchema,
    secret: secretVolumeSchema.optional(),
  })
  .strict()
  .refine(
    (volume) => volume.configMap !== undefined || volume.secret !== undefined,
    {
      message: "Workflow volumes must declare configMap or secret",
    }
  );

const argoWorkflowVolumeMountSchema = z
  .object({
    mountPath: z.string().min(1),
    name: kubernetesNameSchema,
    readOnly: z.boolean().optional(),
    subPath: z.string().min(1).optional(),
  })
  .strict();

const argoWorkflowResourceRequirementsSchema = z
  .object({
    limits: stringMapSchema.optional(),
    requests: stringMapSchema.optional(),
  })
  .strict();

const argoWorkflowArtifactSchema = z
  .object({
    from: z.string().min(1).optional(),
    name: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();

const argoWorkflowTemplateSchema = z
  .object({
    container: z
      .object({
        args: z.array(z.string().min(1)).min(1),
        command: z.array(z.string().min(1)).min(1).optional(),
        env: z
          .array(
            z.object({ name: z.string().min(1), value: z.string() }).strict()
          )
          .optional(),
        image: z.string().min(1),
        imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]),
        name: z.string().min(1).optional(),
        resources: argoWorkflowResourceRequirementsSchema.optional(),
        volumeMounts: z.array(argoWorkflowVolumeMountSchema),
      })
      .strict()
      .optional(),
    dag: z
      .object({
        tasks: z
          .array(
            z
              .object({
                dependencies: z.array(z.string().min(1)).optional(),
                arguments: z
                  .object({
                    artifacts: z.array(argoWorkflowArtifactSchema).optional(),
                  })
                  .strict()
                  .optional(),
                name: z.string().min(1),
                template: z.string().min(1),
              })
              .strict()
          )
          .min(1),
      })
      .strict()
      .optional(),
    inputs: z
      .object({
        artifacts: z.array(argoWorkflowArtifactSchema).optional(),
        parameters: z
          .array(z.object({ name: z.string().min(1) }).strict())
          .optional(),
      })
      .strict()
      .optional(),
    outputs: z
      .object({
        artifacts: z.array(argoWorkflowArtifactSchema),
      })
      .strict()
      .optional(),
    name: z.string().min(1),
  })
  .strict()
  .refine(
    (template) =>
      template.container !== undefined || template.dag !== undefined,
    {
      message: "Workflow templates must declare container or dag",
    }
  );

export const runnerArgoWorkflowManifestSchema = z
  .object({
    apiVersion: z.literal(ARGO_WORKFLOW_API_VERSION),
    kind: z.literal(ARGO_WORKFLOW_KIND),
    metadata: z
      .object({
        annotations: z.record(z.string().min(1), z.string().min(1)).optional(),
        generateName: z.string().min(1).optional(),
        labels: z.record(z.string().min(1), labelValueSchema).optional(),
        name: z.string().min(1).optional(),
        namespace: kubernetesNameSchema,
      })
      .strict()
      .refine(
        (metadata) =>
          metadata.name !== undefined || metadata.generateName !== undefined,
        { message: "Workflow metadata must declare name or generateName" }
      ),
    spec: z
      .object({
        activeDeadlineSeconds: z.number().int().positive().optional(),
        entrypoint: z.literal(RUNNER_WORKFLOW_ENTRYPOINT),
        imagePullSecrets: z
          .array(z.object({ name: kubernetesNameSchema }).strict())
          .optional(),
        podMetadata: z
          .object({
            labels: z.record(z.string().min(1), labelValueSchema).optional(),
          })
          .strict()
          .optional(),
        serviceAccountName: kubernetesNameSchema,
        onExit: z.string().min(1).optional(),
        templates: z.array(argoWorkflowTemplateSchema).min(2),
        ttlStrategy: z
          .object({
            secondsAfterCompletion: z.number().int().positive().optional(),
            secondsAfterFailure: z.number().int().positive().optional(),
            secondsAfterSuccess: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        volumes: z.array(argoWorkflowVolumeSchema).min(1),
      })
      .strict(),
  })
  .strict();

const buildRunnerArgoWorkflowOptionsSchema = z
  .object({
    activeDeadlineSeconds: z.number().int().positive().optional(),
    eventAuthSecretKey: z.string().min(1).optional(),
    eventAuthSecretName: kubernetesNameSchema.optional(),
    generateName: z.string().min(1).optional(),
    githubAuthSecretName: kubernetesNameSchema.optional(),
    annotations: z
      .record(z.string().min(1), z.string().min(1).optional())
      .default({}),
    image: z.string().min(1).default(RUNNER_WORKFLOW_IMAGE),
    imagePullPolicy: z
      .enum(["Always", "IfNotPresent", "Never"])
      .default("Always"),
    imagePullSecretName: kubernetesNameSchema.optional(),
    labels: z
      .record(z.string().min(1), z.string().min(1).optional())
      .default({}),
    name: z.string().min(1).optional(),
    namespace: kubernetesNameSchema,
    opencodeAuthSecretName: kubernetesNameSchema.optional(),
    opencodeOpenaiAccountsSecret: z
      .object({
        key: z.string().min(1).optional(),
        name: kubernetesNameSchema,
      })
      .strict()
      .optional(),
    payloadConfigMapKey: z.string().min(1).default("payload.json"),
    payloadConfigMapName: kubernetesNameSchema,
    queueName: kubernetesNameSchema.optional(),
    resources: argoWorkflowResourceRequirementsSchema.optional(),
    scheduleConfigMapKey: z.string().min(1).default("schedule.yaml"),
    scheduleConfigMapName: kubernetesNameSchema,
    serviceAccountName: kubernetesNameSchema.default(
      RUNNER_WORKFLOW_SERVICE_ACCOUNT
    ),
    taskDescriptorConfigMapName: kubernetesNameSchema,
    ttlStrategy: z
      .object({
        secondsAfterCompletion: z.number().int().positive().optional(),
        secondsAfterFailure: z.number().int().positive().optional(),
        secondsAfterSuccess: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (options) =>
      options.name !== undefined || options.generateName !== undefined,
    {
      message: "Runner Workflow options must declare name or generateName",
    }
  );

export type ArgoWorkflowManifest = z.infer<
  typeof runnerArgoWorkflowManifestSchema
>;
export type BuildRunnerArgoWorkflowOptions = z.input<
  typeof buildRunnerArgoWorkflowOptionsSchema
> & {
  plan: WorkflowExecutionPlan;
};

type ParsedBuildRunnerArgoWorkflowOptions = z.output<
  typeof buildRunnerArgoWorkflowOptionsSchema
> & {
  plan: WorkflowExecutionPlan;
};

export function buildRunnerArgoWorkflowManifest(
  rawOptions: BuildRunnerArgoWorkflowOptions
): ArgoWorkflowManifest {
  const { plan, ...schemaOptions } = rawOptions;
  const options: ParsedBuildRunnerArgoWorkflowOptions = {
    ...buildRunnerArgoWorkflowOptionsSchema.parse(schemaOptions),
    plan,
  };
  const graph = compileArgoExecutionGraph(plan);
  const { volumeMounts, volumes } = runnerWorkflowStorage(options, graph.tasks);
  return runnerArgoWorkflowManifestSchema.parse({
    apiVersion: ARGO_WORKFLOW_API_VERSION,
    kind: ARGO_WORKFLOW_KIND,
    metadata: {
      annotations: compactRecord(options.annotations),
      ...(options.name ? { name: options.name } : {}),
      ...(options.generateName ? { generateName: options.generateName } : {}),
      labels: compactRecord({
        "pipeline.oisin.dev/source": "argo-workflow",
        "pipeline.oisin.dev/workflow": plan.workflowId,
        ...options.labels,
      }),
      namespace: options.namespace,
    },
    spec: {
      ...(options.activeDeadlineSeconds
        ? { activeDeadlineSeconds: options.activeDeadlineSeconds }
        : {}),
      entrypoint: RUNNER_WORKFLOW_ENTRYPOINT,
      ...(options.imagePullSecretName
        ? { imagePullSecrets: [{ name: options.imagePullSecretName }] }
        : {}),
      ...(options.queueName
        ? {
            podMetadata: {
              labels: { "kueue.x-k8s.io/queue-name": options.queueName },
            },
          }
        : {}),
      onExit: "pipeline-finalizer",
      serviceAccountName: options.serviceAccountName,
      templates: [
        {
          dag: {
            tasks: graph.tasks.map((task) => ({
              ...(task.dependencies.length > 0
                ? { dependencies: task.dependencies }
                : {}),
              name: task.taskName,
              template: task.templateName,
            })),
          },
          name: RUNNER_WORKFLOW_ENTRYPOINT,
        },
        ...graph.tasks.map((task) =>
          runnerCommandTemplate(task, options, volumeMounts)
        ),
        runnerFinalizerTemplate(options, volumeMounts),
      ],
      ...(options.ttlStrategy ? { ttlStrategy: options.ttlStrategy } : {}),
      volumes,
    },
  });
}

export function stringifyRunnerArgoWorkflow(
  workflow: ArgoWorkflowManifest
): string {
  return stringify(runnerArgoWorkflowManifestSchema.parse(workflow));
}

function runnerWorkflowStorage(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  tasks: ArgoExecutableTask[]
): {
  volumeMounts: z.infer<typeof argoWorkflowVolumeMountSchema>[];
  volumes: z.infer<typeof argoWorkflowVolumeSchema>[];
} {
  const volumes: z.infer<typeof argoWorkflowVolumeSchema>[] = [
    {
      configMap: {
        items: [{ key: options.payloadConfigMapKey, path: "payload.json" }],
        name: options.payloadConfigMapName,
      },
      name: "runner-payload",
    },
    {
      configMap: {
        items: [{ key: options.scheduleConfigMapKey, path: "schedule.yaml" }],
        name: options.scheduleConfigMapName,
      },
      name: "runner-schedule",
    },
    {
      configMap: {
        items: tasks.map((task) => ({
          key: `${task.taskName}.json`,
          path: `${task.taskName}.json`,
        })),
        name: options.taskDescriptorConfigMapName,
      },
      name: "runner-task-descriptor",
    },
  ];
  const volumeMounts: z.infer<typeof argoWorkflowVolumeMountSchema>[] = [
    {
      mountPath: RUNNER_WORKFLOW_PAYLOAD_PATH,
      name: "runner-payload",
      readOnly: true,
      subPath: "payload.json",
    },
    {
      mountPath: RUNNER_WORKFLOW_SCHEDULE_PATH,
      name: "runner-schedule",
      readOnly: true,
      subPath: "schedule.yaml",
    },
  ];

  if (options.eventAuthSecretName) {
    volumes.push({
      name: "runner-event-auth",
      secret: {
        ...(options.eventAuthSecretKey
          ? {
              items: [
                {
                  key: options.eventAuthSecretKey,
                  path: options.eventAuthSecretKey,
                },
              ],
            }
          : {}),
        secretName: options.eventAuthSecretName,
      },
    });
    volumeMounts.push({
      mountPath: "/etc/pipeline/event-auth",
      name: "runner-event-auth",
      readOnly: true,
    });
  }

  if (options.opencodeAuthSecretName) {
    volumes.push({
      name: "opencode-auth",
      secret: {
        defaultMode: 0o400,
        items: [{ key: "auth.json", path: "auth.json" }],
        secretName: options.opencodeAuthSecretName,
      },
    });
    volumeMounts.push({
      mountPath: "/root/.local/share/opencode/auth.json",
      name: "opencode-auth",
      readOnly: true,
      subPath: "auth.json",
    });
  }

  if (options.githubAuthSecretName) {
    volumes.push({
      name: "github-auth",
      secret: {
        items: [
          { key: "gitconfig", path: "gitconfig" },
          { key: "git-credentials", path: "git-credentials" },
          { key: "hosts.yml", path: "hosts.yml" },
        ],
        secretName: options.githubAuthSecretName,
      },
    });
    volumeMounts.push(
      {
        mountPath: "/root/.gitconfig",
        name: "github-auth",
        readOnly: true,
        subPath: "gitconfig",
      },
      {
        mountPath: "/root/.git-credentials",
        name: "github-auth",
        readOnly: true,
        subPath: "git-credentials",
      },
      {
        mountPath: "/root/.config/gh/hosts.yml",
        name: "github-auth",
        readOnly: true,
        subPath: "hosts.yml",
      }
    );
  }

  return {
    volumeMounts: z.array(argoWorkflowVolumeMountSchema).parse(volumeMounts),
    volumes: z.array(argoWorkflowVolumeSchema).parse(volumes),
  };
}

function runnerCommandTemplate(
  task: ArgoExecutableTask,
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: z.infer<typeof argoWorkflowVolumeMountSchema>[]
): z.infer<typeof argoWorkflowTemplateSchema> {
  const taskVolumeMount: z.infer<typeof argoWorkflowVolumeMountSchema> = {
    mountPath: DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH,
    name: "runner-task-descriptor",
    readOnly: true,
    subPath: `${task.taskName}.json`,
  };
  return {
    container: {
      args: [
        "runner-command",
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
        "--schedule-file",
        RUNNER_WORKFLOW_SCHEDULE_PATH,
      ],
      command: ["moka"],
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      ...(options.resources ? { resources: options.resources } : {}),
      volumeMounts: [...volumeMounts, taskVolumeMount],
    },
    name: task.templateName,
  };
}

function runnerFinalizerTemplate(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: z.infer<typeof argoWorkflowVolumeMountSchema>[]
): z.infer<typeof argoWorkflowTemplateSchema> {
  return {
    container: {
      args: [
        "runner-finalize",
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
        "--schedule-file",
        RUNNER_WORKFLOW_SCHEDULE_PATH,
        "--argo-status",
        "{{workflow.status}}",
      ],
      command: ["moka"],
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      ...(options.resources ? { resources: options.resources } : {}),
      volumeMounts,
    },
    name: "pipeline-finalizer",
  };
}

function compactRecord(
  input: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}
