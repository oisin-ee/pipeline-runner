import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { stringify } from "yaml";
import { z } from "zod";
import {
  ArgoGraphCompilerError,
  compileArgoExecutionGraph,
} from "./argo-graph";
import {
  type ArgoWorkflowManifest,
  buildDynamicRunnerArgoWorkflowManifest,
  buildRunnerArgoWorkflowManifest,
  runnerArgoWorkflowManifestSchema,
} from "./argo-workflow";
import type { PipelineConfig } from "./config";
import { brokerAuthOptionSchema } from "./credentials/broker";
import { normalizeRunnerRepositoryForSubmit } from "./git-remote-url";
import {
  type CompiledScheduleArtifact,
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "./planning/generate";
import {
  dbAuthOptionSchema,
  mcpGatewayAuthOptionSchema,
} from "./remote/argo/model";
import { buildRunnerTaskDescriptor } from "./runner-command/task-descriptor";
import {
  parseRunnerCommandPayload,
  type RunnerCommandPayload,
  runnerCommandPayloadSchema,
} from "./runner-command-contract";
import {
  type CoreApi,
  type KubernetesArgoIoDependencies,
  KubernetesArgoService,
  KubernetesArgoServiceLive,
  type WorkflowApi,
} from "./runtime/services/kubernetes-argo-service";
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

const createdWorkflowSchema = z
  .object({
    metadata: z
      .object({
        name: z.string().min(1).optional(),
        uid: z.string().min(1).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const submitRunnerArgoWorkflowOptionsSchema = z
  .object({
    brokerAuth: brokerAuthOptionSchema,
    // PIPE-94.4: optional secret ref for MOKA_DB_URL injection in runner pods.
    // Shared shape (single owner in remote/argo/model). Absent → no MOKA_DB_URL.
    dbAuth: dbAuthOptionSchema.optional(),
    eventAuthSecretKey: z.string().min(1).optional(),
    eventAuthSecretName: z.string().min(1).optional(),
    generateName: z.string().min(1).optional(),
    gitCredentialsSecretName: z.string().min(1).optional(),
    githubAuthSecretName: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).optional(),
    imagePullSecretName: z.string().min(1).optional(),
    kubeconfigPath: z.string().min(1).optional(),
    // Optional secret ref for PIPELINE_MCP_GATEWAY_AUTHORIZATION injection in
    // runner pods. Shared shape (single owner in remote/argo/model). Absent →
    // no PIPELINE_MCP_GATEWAY_AUTHORIZATION.
    mcpGatewayAuth: mcpGatewayAuthOptionSchema.optional(),
    name: z.string().min(1).optional(),
    namespace: z.string().min(1),
    payloadJson: z.string().min(1),
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

export interface SubmitRunnerArgoWorkflowDependencies {
  coreApi?: CoreApi;
  kubeConfig?: KubernetesArgoIoDependencies["kubeConfig"];
  workflowApi?: WorkflowApi;
}

export type SubmitDynamicRunnerArgoWorkflowOptions = Omit<
  SubmitRunnerArgoWorkflowOptions,
  "scheduleYaml"
> & {
  workflowId: string;
};

export function submitRunnerArgoWorkflow(
  rawOptions: SubmitRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies = {}
): Promise<SubmitRunnerArgoWorkflowResult> {
  return Effect.runPromise(
    Effect.provide(
      Effect.suspend(() =>
        submitRunnerArgoWorkflowEffect(rawOptions, dependencies)
      ),
      KubernetesArgoServiceLive
    )
  );
}

export function submitDynamicRunnerArgoWorkflow(
  rawOptions: SubmitDynamicRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies = {}
): Promise<SubmitRunnerArgoWorkflowResult> {
  return Effect.runPromise(
    Effect.provide(
      Effect.suspend(() =>
        submitDynamicRunnerArgoWorkflowEffect(rawOptions, dependencies)
      ),
      KubernetesArgoServiceLive
    )
  );
}

function submitRunnerArgoWorkflowEffect(
  rawOptions: SubmitRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies
): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> {
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
  const graphEffect = compileSubmitArgoGraph(compiled).pipe(
    Effect.mapError(
      (error) =>
        new Error(
          `Schedule '${compiled.workflowId}' cannot be submitted: ${error.message}`
        )
    )
  );
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
    brokerAuth: options.brokerAuth,
    dbAuth: options.dbAuth,
    mcpGatewayAuth: options.mcpGatewayAuth,
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
    payloadConfigMapName,
    plan: compiled.plan,
    scheduleConfigMapName: scheduleArtifactConfigMapName,
    serviceAccountName: options.serviceAccountName,
    taskDescriptorConfigMapName,
  });
  return Effect.gen(function* () {
    const service = yield* KubernetesArgoService;
    const graph = yield* graphEffect;
    yield* service.createConfigMap({
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
      dependencies,
      namespace: options.namespace,
      options,
    });
    yield* service.createConfigMap({
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
      dependencies,
      namespace: options.namespace,
      options,
    });
    yield* service.createConfigMap({
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
      dependencies,
      namespace: options.namespace,
      options,
    });
    const response = yield* service.createWorkflow({
      body: runnerArgoWorkflowManifestSchema.parse(workflow),
      dependencies,
      namespace: options.namespace,
      options,
    });
    return workflowSubmitResult(response, workflow, {
      namespace: options.namespace,
      payloadConfigMapName,
      scheduleConfigMapName: scheduleArtifactConfigMapName,
      taskDescriptorConfigMapName,
    });
  });
}

function submitDynamicRunnerArgoWorkflowEffect(
  rawOptions: SubmitDynamicRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies
): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> {
  const { config: _config, workflowId, ...schemaOptions } = rawOptions;
  const options = submitRunnerArgoWorkflowOptionsSchema
    .omit({ scheduleYaml: true })
    .extend({ workflowId: z.string().min(1) })
    .parse({ ...schemaOptions, workflowId });
  const parsedPayload = runnerCommandPayloadSchema.parse(
    parseRunnerCommandPayload(options.payloadJson)
  );
  const { payload, payloadJson } = normalizeRunnerPayloadForSubmit({
    payload: parsedPayload,
    payloadJson: options.payloadJson,
  });
  if (payload.workflow.id !== workflowId) {
    throw new Error(
      `Runner payload workflow '${payload.workflow.id}' does not match dynamic workflow '${workflowId}'`
    );
  }
  const payloadConfigMapName = `pipeline-payload-${randomBytes(6).toString("hex")}`;
  const labels = {
    "pipeline.oisin.dev/project": payload.run.project,
    "pipeline.oisin.dev/run-id": payload.run.id,
    "pipeline.oisin.dev/source": "argo-workflow",
    "pipeline.oisin.dev/workflow": workflowId,
  };
  const annotations =
    payload.task.kind === "ticket"
      ? {
          "pipeline.oisin.dev/ticket-id": payload.task.id,
          "pipeline.oisin.dev/ticket-project": payload.run.project,
          "pipeline.oisin.dev/ticket-title": payload.task.title,
        }
      : {};
  const workflow = buildDynamicRunnerArgoWorkflowManifest({
    annotations,
    brokerAuth: options.brokerAuth,
    dbAuth: options.dbAuth,
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
    payloadConfigMapName,
    serviceAccountName: options.serviceAccountName,
    workflowId,
  });
  return Effect.gen(function* () {
    const service = yield* KubernetesArgoService;
    yield* service.createConfigMap({
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
      dependencies,
      namespace: options.namespace,
      options,
    });
    const response = yield* service.createWorkflow({
      body: runnerArgoWorkflowManifestSchema.parse(workflow),
      dependencies,
      namespace: options.namespace,
      options,
    });
    return workflowSubmitResult(response, workflow, {
      namespace: options.namespace,
      payloadConfigMapName,
    });
  });
}

function workflowSubmitResult(
  response: unknown,
  workflow: ArgoWorkflowManifest,
  base: Omit<SubmitRunnerArgoWorkflowResult, "workflowName" | "workflowUid">
): SubmitRunnerArgoWorkflowResult {
  const created = createdWorkflowSchema.parse(response);
  return workflowSubmitResultSchema.parse({
    ...base,
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
): Effect.Effect<
  ReturnType<typeof compileArgoExecutionGraph>,
  ArgoGraphCompilerError
> {
  return Effect.try({
    try: () => compileArgoExecutionGraph(compiled.plan),
    catch: (error) => {
      if (error instanceof ArgoGraphCompilerError) {
        return error;
      }
      throw error;
    },
  });
}
