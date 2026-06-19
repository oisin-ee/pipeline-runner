import { stringify } from "yaml";
import { z } from "zod";
import {
  type ArgoExecutableTask,
  compileArgoExecutionGraph,
} from "./argo-graph";
import type { WorkflowExecutionPlan } from "./planning/compile";
import { DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH } from "./runner-command/task-descriptor";

const ARGO_WORKFLOW_API_VERSION = "argoproj.io/v1alpha1";
const ARGO_WORKFLOW_KIND = "Workflow";
const RUNNER_WORKFLOW_IMAGE = "ghcr.io/oisin-ee/pipeline-runner:latest";
const RUNNER_WORKFLOW_SERVICE_ACCOUNT = "pipeline-runner";
const RUNNER_WORKFLOW_ENTRYPOINT = "pipeline";
const RUNNER_WORKFLOW_START_TASK = "workflow-start";
const RUNNER_WORKFLOW_PAYLOAD_PATH = "/etc/pipeline/payload.json";
const RUNNER_WORKFLOW_SCHEDULE_PATH = "/etc/pipeline/schedule.yaml";
const RUNNER_GIT_CREDENTIALS_PATH = "/etc/pipeline/git-credentials";
// Retry a runner node on transient infrastructure disruption, NOT on genuine
// task failures (exit 1 / Failed) which node-level retries/remediation own.
// retryPolicy "Always" makes both Errored and Failed nodes retry candidates;
// the expression then allowlists the transient-infra outcomes:
//   - status "Error": node went NotReady with no task exit code recorded.
//   - exit 70: moka startup/internal infra failure.
//   - exit 137: pod SIGKILL/OOM/eviction under node pressure. Argo records this
//     as a "pod deleted" node that carries exitCode 137 — which is classed such
//     that `status == 'Error'` does NOT match, so it must be matched by code.
// exitCode is compared as a string so an empty code (pure pod-deleted, no exit)
// can never make asInt() throw and silently void the whole expression. A retried
// node reschedules — typically onto a healthy node — while already-Succeeded
// upstream nodes are preserved, so a single pod disruption no longer fails the run.
const RUNNER_RETRY_STRATEGY = {
  expression:
    "lastRetry.status == 'Error' || lastRetry.exitCode == '70' || lastRetry.exitCode == '137'",
  limit: "3",
  retryPolicy: "Always",
} as const;
const RUNNER_OPENCODE_ENV = [
  { name: "CODEX_AUTH_PER_PROJECT_ACCOUNTS", value: "0" },
] as const;

// Runner containers run the agent plus memory-heavy gate commands (tsc, jest,
// fallow) over the target repo. With no memory request the scheduler
// overcommits a node with parallel agent nodes and the kernel OOM-kills one
// (exit 137 — observed on the RN/Expo test node). Request enough that heavy
// nodes spread across nodes; allow a generous limit for large typecheck/test
// runs. Overridable per-submit via options.resources.
const DEFAULT_RUNNER_RESOURCES = {
  limits: { cpu: "4", memory: "8Gi" },
  requests: { cpu: "1", memory: "4Gi" },
} as const;

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
    optional: z.boolean().optional(),
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

const argoWorkflowRetryStrategySchema = z
  .object({
    expression: z.string().min(1).optional(),
    limit: z.string().min(1).optional(),
    retryPolicy: z.enum(["Always", "OnError", "OnFailure", "OnTransientError"]),
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
    retryStrategy: argoWorkflowRetryStrategySchema.optional(),
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
    gitCredentialsSecretName: kubernetesNameSchema.optional(),
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
      onExit: "pipeline-finalizer",
      serviceAccountName: options.serviceAccountName,
      templates: [
        {
          dag: {
            tasks: [
              {
                name: RUNNER_WORKFLOW_START_TASK,
                template: RUNNER_WORKFLOW_START_TASK,
              },
              ...graph.tasks.map((task) => ({
                dependencies: [
                  RUNNER_WORKFLOW_START_TASK,
                  ...task.dependencies,
                ],
                name: task.taskName,
                template: task.templateName,
              })),
            ],
          },
          name: RUNNER_WORKFLOW_ENTRYPOINT,
        },
        runnerLifecycleTemplate(options, volumeMounts),
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

  if (options.opencodeOpenaiAccountsSecret) {
    const accountsKey =
      options.opencodeOpenaiAccountsSecret.key ?? "accounts.json";
    volumes.push({
      name: "opencode-openai-accounts",
      secret: {
        defaultMode: 0o400,
        items: [{ key: accountsKey, path: "accounts.json" }],
        secretName: options.opencodeOpenaiAccountsSecret.name,
      },
    });
    // The codex-multi-auth plugin reads both ChatGPT accounts from this global
    // opencode path; without it the runner falls back to the single inline
    // account in auth.json and a transient provider error reads as "all accounts
    // failed". Read-only mirrors the auth.json mount — the run is far shorter
    // than the token lifetime, so no in-pod refresh write is needed.
    volumeMounts.push({
      mountPath: "/root/.opencode/oc-codex-multi-auth-accounts.json",
      name: "opencode-openai-accounts",
      readOnly: true,
      subPath: "accounts.json",
    });
  }

  if (options.gitCredentialsSecretName) {
    volumes.push({
      name: "runner-git-credentials",
      secret: {
        defaultMode: 0o400,
        secretName: options.gitCredentialsSecretName,
      },
    });
    volumeMounts.push({
      mountPath: RUNNER_GIT_CREDENTIALS_PATH,
      name: "runner-git-credentials",
      readOnly: true,
    });
  }

  if (options.githubAuthSecretName) {
    volumes.push({
      name: "github-auth",
      secret: {
        items: [{ key: "hosts.yml", path: "hosts.yml" }],
        secretName: options.githubAuthSecretName,
      },
    });
    volumeMounts.push({
      mountPath: "/root/.config/gh/hosts.yml",
      name: "github-auth",
      readOnly: true,
      subPath: "hosts.yml",
    });
  }

  return {
    volumeMounts: z.array(argoWorkflowVolumeMountSchema).parse(volumeMounts),
    volumes: z.array(argoWorkflowVolumeSchema).parse(volumes),
  };
}

function runnerLifecycleTemplate(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: z.infer<typeof argoWorkflowVolumeMountSchema>[]
): z.infer<typeof argoWorkflowTemplateSchema> {
  return {
    container: {
      args: [
        "runner-lifecycle",
        "--phase",
        "workflow.start",
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
        "--schedule-file",
        RUNNER_WORKFLOW_SCHEDULE_PATH,
      ],
      command: ["moka"],
      env: [...RUNNER_OPENCODE_ENV],
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      resources: options.resources ?? DEFAULT_RUNNER_RESOURCES,
      volumeMounts,
    },
    name: RUNNER_WORKFLOW_START_TASK,
    retryStrategy: { ...RUNNER_RETRY_STRATEGY },
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
      env: [...RUNNER_OPENCODE_ENV],
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      resources: options.resources ?? DEFAULT_RUNNER_RESOURCES,
      volumeMounts: [...volumeMounts, taskVolumeMount],
    },
    name: task.templateName,
    retryStrategy: { ...RUNNER_RETRY_STRATEGY },
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
      env: [...RUNNER_OPENCODE_ENV],
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      resources: options.resources ?? DEFAULT_RUNNER_RESOURCES,
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
