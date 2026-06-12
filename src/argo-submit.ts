import { randomBytes } from "node:crypto";
import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import { stringify } from "yaml";
import { z } from "zod";
import {
  ArgoGraphCompilerError,
  compileArgoExecutionGraph,
} from "./argo-graph";
import {
  buildRunnerArgoWorkflowManifest,
  runnerArgoWorkflowManifestSchema,
} from "./argo-workflow";
import type { PipelineConfig } from "./config";
import { normalizeRunnerRepositoryForSubmit } from "./git-remote-url";
import { buildRunnerTaskDescriptor } from "./runner-command/task-descriptor";
import {
  parseRunnerCommandPayload,
  type RunnerCommandPayload,
  runnerCommandPayloadSchema,
} from "./runner-command-contract";
import {
  type CompiledScheduleArtifact,
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "./schedule-planner";
import { workflowSubmitResultSchema } from "./workflow-submit-contract";

const scheduleIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

const configMapSchema = z
  .object({
    apiVersion: z.literal("v1"),
    data: z.record(z.string().min(1), z.string()),
    kind: z.literal("ConfigMap"),
    metadata: z
      .object({
        labels: z.record(z.string().min(1), z.string().min(1)).optional(),
        name: z.string().min(1),
        namespace: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const submitRunnerArgoWorkflowOptionsSchema = z
  .object({
    eventAuthSecretKey: z.string().min(1).optional(),
    eventAuthSecretName: z.string().min(1).optional(),
    generateName: z.string().min(1).optional(),
    gitCredentialsSecretName: z.string().min(1).optional(),
    githubAuthSecretName: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).optional(),
    imagePullSecretName: z.string().min(1).optional(),
    kubeconfigPath: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    namespace: z.string().min(1),
    opencodeAuthSecretName: z.string().min(1).optional(),
    payloadJson: z.string().min(1),
    queueName: z.string().min(1).optional(),
    scheduleYaml: z.string().min(1),
    serviceAccountName: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (options) =>
      options.name !== undefined || options.generateName !== undefined,
    {
      message: "Argo submit options must declare name or generateName",
    }
  );

const commandScheduleOptionsSchema = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    generatedAt: z.date().default(() => new Date()),
    scheduleId: scheduleIdSchema.optional(),
    task: z.string().min(1),
  })
  .strict();

export type SubmitRunnerArgoWorkflowOptions = z.input<
  typeof submitRunnerArgoWorkflowOptionsSchema
> & {
  config: PipelineConfig;
};
export type SubmitRunnerArgoWorkflowResult = z.infer<
  typeof workflowSubmitResultSchema
>;
export type CommandScheduleOptions = z.input<
  typeof commandScheduleOptionsSchema
>;

type CoreApi = Pick<CoreV1Api, "createNamespacedConfigMap">;
type WorkflowApi = Pick<CustomObjectsApi, "createNamespacedCustomObject">;

export interface SubmitRunnerArgoWorkflowDependencies {
  coreApi?: CoreApi;
  kubeConfig?: KubeConfig;
  workflowApi?: WorkflowApi;
}

export async function submitRunnerArgoWorkflow(
  rawOptions: SubmitRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies = {}
): Promise<SubmitRunnerArgoWorkflowResult> {
  const { config, ...schemaOptions } = rawOptions;
  const options = submitRunnerArgoWorkflowOptionsSchema.parse(schemaOptions);
  const parsedPayload = runnerCommandPayloadSchema.parse(
    parseRunnerCommandPayload(options.payloadJson)
  );
  const { payload, payloadJson } = normalizeRunnerPayloadForSubmit({
    payload: parsedPayload,
    payloadJson: options.payloadJson,
  });
  const compiled = compileScheduleArtifact(
    config,
    parseScheduleArtifact(options.scheduleYaml, "schedule.yaml")
  );
  const payloadConfigMapName = `pipeline-payload-${randomBytes(6).toString("hex")}`;
  const scheduleArtifactConfigMapName = `pipeline-schedule-${randomBytes(6).toString("hex")}`;
  const taskDescriptorConfigMapName = `pipeline-task-descriptors-${randomBytes(6).toString("hex")}`;
  if (payload.workflow.id !== compiled.workflowId) {
    throw new Error(
      `Runner payload workflow '${payload.workflow.id}' does not match schedule workflow '${compiled.workflowId}'`
    );
  }
  const graph = compileSubmitArgoGraph(compiled);
  const labels = {
    "pipeline.oisin.dev/project": payload.run.project,
    "pipeline.oisin.dev/run-id": payload.run.id,
    "pipeline.oisin.dev/source": "argo-workflow",
    "pipeline.oisin.dev/workflow": compiled.workflowId,
  };
  const annotations =
    payload.task.kind === "ticket"
      ? {
          "pipeline.oisin.dev/ticket-id": payload.task.id,
          "pipeline.oisin.dev/ticket-project": payload.run.project,
          "pipeline.oisin.dev/ticket-title": payload.task.title,
        }
      : {};
  const workflow = buildRunnerArgoWorkflowManifest({
    annotations,
    eventAuthSecretKey: options.eventAuthSecretKey,
    eventAuthSecretName: options.eventAuthSecretName,
    generateName: options.generateName,
    gitCredentialsSecretName: options.gitCredentialsSecretName,
    githubAuthSecretName: options.githubAuthSecretName,
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    imagePullSecretName: options.imagePullSecretName,
    labels,
    name: options.name,
    namespace: options.namespace,
    opencodeAuthSecretName: options.opencodeAuthSecretName,
    payloadConfigMapName,
    plan: compiled.plan,
    queueName: options.queueName,
    scheduleConfigMapName: scheduleArtifactConfigMapName,
    serviceAccountName: options.serviceAccountName,
    taskDescriptorConfigMapName,
  });
  const { coreApi, workflowApi } = apiClients(options, dependencies);
  await coreApi.createNamespacedConfigMap({
    body: configMapSchema.parse({
      apiVersion: "v1",
      data: { "payload.json": payloadJson },
      kind: "ConfigMap",
      metadata: {
        labels,
        name: payloadConfigMapName,
        namespace: options.namespace,
      },
    }),
    namespace: options.namespace,
  });
  await coreApi.createNamespacedConfigMap({
    body: configMapSchema.parse({
      apiVersion: "v1",
      data: Object.fromEntries(
        graph.tasks.map((task) => [
          `${task.taskName}.json`,
          `${JSON.stringify(buildRunnerTaskDescriptor(task.nodeId))}\n`,
        ])
      ),
      kind: "ConfigMap",
      metadata: {
        labels,
        name: taskDescriptorConfigMapName,
        namespace: options.namespace,
      },
    }),
    namespace: options.namespace,
  });
  await coreApi.createNamespacedConfigMap({
    body: configMapSchema.parse({
      apiVersion: "v1",
      data: { "schedule.yaml": options.scheduleYaml },
      kind: "ConfigMap",
      metadata: {
        labels,
        name: scheduleArtifactConfigMapName,
        namespace: options.namespace,
      },
    }),
    namespace: options.namespace,
  });
  const response = await workflowApi.createNamespacedCustomObject({
    body: runnerArgoWorkflowManifestSchema.parse(workflow),
    group: "argoproj.io",
    namespace: options.namespace,
    plural: "workflows",
    version: "v1alpha1",
  });
  const created = z
    .object({
      metadata: z
        .object({
          name: z.string().min(1).optional(),
          uid: z.string().min(1).optional(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(response);
  return workflowSubmitResultSchema.parse({
    namespace: options.namespace,
    payloadConfigMapName,
    scheduleConfigMapName: scheduleArtifactConfigMapName,
    taskDescriptorConfigMapName,
    workflowName: created.metadata.name ?? workflow.metadata.name,
    workflowUid: created.metadata.uid,
  });
}

export function buildCommandScheduleYaml(
  rawOptions: CommandScheduleOptions
): string {
  const options = commandScheduleOptionsSchema.parse(rawOptions);
  const scheduleId =
    options.scheduleId ?? `custom-${randomBytes(8).toString("hex")}`;
  return stringify({
    generated_at: options.generatedAt.toISOString(),
    kind: "pipeline-schedule",
    root_workflow: "root",
    schedule_id: scheduleId,
    source_entrypoint: "custom",
    task: options.task,
    version: 1,
    workflows: {
      root: {
        nodes: [
          {
            command: options.command,
            id: "command",
            kind: "command",
          },
        ],
      },
    },
  });
}

function normalizeRunnerPayloadForSubmit(input: {
  payload: RunnerCommandPayload;
  payloadJson: string;
}): { payload: RunnerCommandPayload; payloadJson: string } {
  const repository = normalizeRunnerRepositoryForSubmit(
    input.payload.repository
  );
  if (repository === input.payload.repository) {
    return input;
  }
  const payload = runnerCommandPayloadSchema.parse({
    ...input.payload,
    repository,
  });
  return { payload, payloadJson: JSON.stringify(payload) };
}

function compileSubmitArgoGraph(
  compiled: CompiledScheduleArtifact
): ReturnType<typeof compileArgoExecutionGraph> {
  try {
    return compileArgoExecutionGraph(compiled.plan);
  } catch (err) {
    if (err instanceof ArgoGraphCompilerError) {
      throw new Error(
        `Schedule '${compiled.workflowId}' cannot be submitted: ${err.message}`
      );
    }
    throw err;
  }
}

function apiClients(
  options: z.output<typeof submitRunnerArgoWorkflowOptionsSchema>,
  dependencies: SubmitRunnerArgoWorkflowDependencies
): { coreApi: CoreApi; workflowApi: WorkflowApi } {
  if (dependencies.coreApi && dependencies.workflowApi) {
    return {
      coreApi: dependencies.coreApi,
      workflowApi: dependencies.workflowApi,
    };
  }
  const kubeConfig = dependencies.kubeConfig ?? new KubeConfig();
  if (!dependencies.kubeConfig) {
    if (options.kubeconfigPath) {
      kubeConfig.loadFromFile(options.kubeconfigPath);
    } else {
      kubeConfig.loadFromDefault();
    }
  }
  return {
    coreApi: dependencies.coreApi ?? kubeConfig.makeApiClient(CoreV1Api),
    workflowApi:
      dependencies.workflowApi ?? kubeConfig.makeApiClient(CustomObjectsApi),
  };
}
