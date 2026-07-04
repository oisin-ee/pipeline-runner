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
  type ScheduleArtifact,
} from "./planning/generate";
import {
  type ArgoWorkflowPodGC,
  argoWorkflowActiveDeadlineSecondsSchema,
  argoWorkflowPodGcSchema,
  argoWorkflowTtlStrategySchema,
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
  type ConfigMapOwnerReferencesPatch,
  type CoreApi,
  type KubernetesArgoClientOptions,
  type KubernetesArgoIoDependencies,
  KubernetesArgoService,
  KubernetesArgoServiceLive,
  type KubernetesOwnerReference,
  type WorkflowApi,
} from "./runtime/services/kubernetes-argo-service";
import { appendPullRequestDelivery } from "./schedule/passes/open-pull-request";
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

const workflowOwnerReferenceSchema = z
  .object({
    apiVersion: z.literal("argoproj.io/v1alpha1"),
    kind: z.literal("Workflow"),
    name: z.string().min(1),
    uid: z.string().min(1),
  })
  .strict();

const configMapOwnerReferencesPatchSchema = z
  .object({
    metadata: z
      .object({
        ownerReferences: z.tuple([workflowOwnerReferenceSchema]),
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

const submitRunnerArgoWorkflowBaseOptionShape = {
  activeDeadlineSeconds: argoWorkflowActiveDeadlineSecondsSchema.optional(),
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
  kubeContext: z.string().min(1).optional(),
  kubeconfigPath: z.string().min(1).optional(),
  // Optional secret ref for PIPELINE_MCP_GATEWAY_AUTHORIZATION injection in
  // runner pods. Shared shape (single owner in remote/argo/model). Absent →
  // no PIPELINE_MCP_GATEWAY_AUTHORIZATION.
  mcpGatewayAuth: mcpGatewayAuthOptionSchema.optional(),
  name: z.string().min(1).optional(),
  namespace: z.string().min(1),
  npmRegistryAuthSecretName: z.string().min(1).optional(),
  payloadJson: z.string().min(1),
  podGC: argoWorkflowPodGcSchema.optional(),
  serviceAccountName: z.string().min(1).optional(),
  ttlStrategy: argoWorkflowTtlStrategySchema.optional(),
};

const submitRunnerArgoWorkflowOptionsSchema = z
  .object({
    ...submitRunnerArgoWorkflowBaseOptionShape,
    scheduleYaml: z.string().min(1),
  })
  .strict()
  .refine(hasWorkflowName, {
    message: "Argo submit options must declare name or generateName",
  });

const submitDynamicRunnerArgoWorkflowOptionsSchema = z
  .object({
    ...submitRunnerArgoWorkflowBaseOptionShape,
    workflowId: z.string().min(1),
  })
  .strict()
  .refine(hasWorkflowName, {
    message: "Argo submit options must declare name or generateName",
  });

const commandScheduleOptionsSchema = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    deliverPullRequest: z.boolean().default(false),
    generatedAt: z.date().default(() => new Date()),
    scheduleId: scheduleIdSchema.optional(),
    task: z.string().min(1),
  })
  .strict();

function hasWorkflowName(options: {
  generateName?: string;
  name?: string;
}): boolean {
  return options.name !== undefined || options.generateName !== undefined;
}

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

export type SubmitDynamicRunnerArgoWorkflowOptions = z.input<
  typeof submitDynamicRunnerArgoWorkflowOptionsSchema
> & {
  config: PipelineConfig;
};

type ConfigMapManifest = z.infer<typeof configMapSchema>;

interface RunConfigMapSpec {
  readonly body: ConfigMapManifest;
  readonly name: string;
}

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
    activeDeadlineSeconds: options.activeDeadlineSeconds,
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
    npmRegistryAuthSecretName: options.npmRegistryAuthSecretName,
    payloadConfigMapName,
    plan: compiled.plan,
    scheduleConfigMapName: scheduleArtifactConfigMapName,
    serviceAccountName: options.serviceAccountName,
    taskDescriptorConfigMapName,
    ttlStrategy: options.ttlStrategy,
  });
  return Effect.gen(function* () {
    const graph = yield* graphEffect;
    const configMaps = staticRunConfigMaps({
      labels,
      namespace: options.namespace,
      payloadConfigMapName,
      payloadJson,
      scheduleConfigMapName: scheduleArtifactConfigMapName,
      scheduleYaml: options.scheduleYaml,
      taskDescriptorConfigMapName,
      tasks: graph.tasks,
    });
    const createdConfigMapNames = yield* createRunConfigMaps({
      configMaps,
      dependencies,
      namespace: options.namespace,
      options,
    });
    return yield* submitWorkflowWithRunConfigMaps({
      configMapNames: createdConfigMapNames,
      dependencies,
      namespace: options.namespace,
      options,
      resultExtras: {
        payloadConfigMapName,
        scheduleConfigMapName: scheduleArtifactConfigMapName,
        taskDescriptorConfigMapName,
      },
      workflow,
      workflowFieldOverrides: {
        podGC: options.podGC,
      },
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
  const { config: _config, ...schemaOptions } = rawOptions;
  const options =
    submitDynamicRunnerArgoWorkflowOptionsSchema.parse(schemaOptions);
  const parsedPayload = runnerCommandPayloadSchema.parse(
    parseRunnerCommandPayload(options.payloadJson)
  );
  const { payload, payloadJson } = normalizeRunnerPayloadForSubmit({
    payload: parsedPayload,
    payloadJson: options.payloadJson,
  });
  if (payload.workflow.id !== options.workflowId) {
    throw new Error(
      `Runner payload workflow '${payload.workflow.id}' does not match dynamic workflow '${options.workflowId}'`
    );
  }
  const payloadConfigMapName = `pipeline-payload-${randomBytes(6).toString("hex")}`;
  const labels = {
    "pipeline.oisin.dev/project": payload.run.project,
    "pipeline.oisin.dev/run-id": payload.run.id,
    "pipeline.oisin.dev/source": "argo-workflow",
    "pipeline.oisin.dev/workflow": options.workflowId,
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
    activeDeadlineSeconds: options.activeDeadlineSeconds,
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
    mcpGatewayAuth: options.mcpGatewayAuth,
    labels,
    name: options.name,
    namespace: options.namespace,
    npmRegistryAuthSecretName: options.npmRegistryAuthSecretName,
    payloadConfigMapName,
    serviceAccountName: options.serviceAccountName,
    ttlStrategy: options.ttlStrategy,
    workflowId: options.workflowId,
  });
  return Effect.gen(function* () {
    const configMaps = dynamicRunConfigMaps({
      labels,
      namespace: options.namespace,
      payloadConfigMapName,
      payloadJson,
    });
    const createdConfigMapNames = yield* createRunConfigMaps({
      configMaps,
      dependencies,
      namespace: options.namespace,
      options,
    });
    return yield* submitWorkflowWithRunConfigMaps({
      configMapNames: createdConfigMapNames,
      dependencies,
      namespace: options.namespace,
      options,
      resultExtras: { payloadConfigMapName },
      workflow,
      workflowFieldOverrides: {
        podGC: options.podGC,
      },
    });
  });
}

function staticRunConfigMaps(input: {
  labels: Record<string, string>;
  namespace: string;
  payloadConfigMapName: string;
  payloadJson: string;
  scheduleConfigMapName: string;
  scheduleYaml: string;
  taskDescriptorConfigMapName: string;
  tasks: ReturnType<typeof compileArgoExecutionGraph>["tasks"];
}): readonly RunConfigMapSpec[] {
  return [
    runConfigMap({
      data: { "payload.json": input.payloadJson },
      labels: input.labels,
      name: input.payloadConfigMapName,
      namespace: input.namespace,
    }),
    runConfigMap({
      data: Object.fromEntries(
        input.tasks.map((task) => [
          `${task.taskName}.json`,
          `${JSON.stringify(buildRunnerTaskDescriptor(task.nodeId))}\n`,
        ])
      ),
      labels: input.labels,
      name: input.taskDescriptorConfigMapName,
      namespace: input.namespace,
    }),
    runConfigMap({
      data: { "schedule.yaml": input.scheduleYaml },
      labels: input.labels,
      name: input.scheduleConfigMapName,
      namespace: input.namespace,
    }),
  ];
}

function dynamicRunConfigMaps(input: {
  labels: Record<string, string>;
  namespace: string;
  payloadConfigMapName: string;
  payloadJson: string;
}): readonly RunConfigMapSpec[] {
  return [
    runConfigMap({
      data: { "payload.json": input.payloadJson },
      labels: input.labels,
      name: input.payloadConfigMapName,
      namespace: input.namespace,
    }),
  ];
}

function runConfigMap(input: {
  data: Record<string, string>;
  labels: Record<string, string>;
  name: string;
  namespace: string;
}): RunConfigMapSpec {
  const body = configMapSchema.parse({
    apiVersion: "v1",
    data: input.data,
    kind: "ConfigMap",
    metadata: {
      labels: input.labels,
      name: input.name,
      namespace: input.namespace,
    },
  });
  return { body, name: input.name };
}

function createRunConfigMaps(input: {
  configMaps: readonly RunConfigMapSpec[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
}): Effect.Effect<readonly string[], unknown, KubernetesArgoService> {
  const createdConfigMapNames: string[] = [];
  return Effect.gen(function* () {
    const service = yield* KubernetesArgoService;
    yield* Effect.forEach(input.configMaps, (configMap) =>
      service
        .createConfigMap({
          body: configMap.body,
          dependencies: input.dependencies,
          namespace: input.namespace,
          options: input.options,
        })
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              createdConfigMapNames.push(configMap.name);
            })
          )
        )
    );
    return createdConfigMapNames;
  }).pipe(
    Effect.catch((error) =>
      cleanupRunConfigMapsOnFailure({
        configMapNames: createdConfigMapNames,
        dependencies: input.dependencies,
        error,
        namespace: input.namespace,
        options: input.options,
      })
    )
  );
}

function ownRunConfigMaps(input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
  result: SubmitRunnerArgoWorkflowResult;
}): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> {
  const ownerReference = workflowOwnerReference(input.result);
  if (ownerReference === undefined) {
    return warnRunConfigMapOwnershipSkipped({
      error: new Error(missingWorkflowUidMessage(input.result)),
      result: input.result,
    }).pipe(Effect.as(input.result));
  }
  const body = configMapOwnerReferencesPatch(ownerReference);
  return patchRunConfigMapOwnerReferences({
    body,
    configMapNames: input.configMapNames,
    dependencies: input.dependencies,
    namespace: input.namespace,
    options: input.options,
  }).pipe(Effect.as(input.result));
}

function ownRunConfigMapsBestEffort(input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
  result: SubmitRunnerArgoWorkflowResult;
}): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  never,
  KubernetesArgoService
> {
  return ownRunConfigMaps(input).pipe(
    Effect.catch((error) =>
      warnRunConfigMapOwnershipSkipped({
        error,
        result: input.result,
      }).pipe(Effect.as(input.result))
    )
  );
}

function warnRunConfigMapOwnershipSkipped(input: {
  error: unknown;
  result: SubmitRunnerArgoWorkflowResult;
}): Effect.Effect<void> {
  return Effect.sync(() => {
    const reason = errorMessage(input.error);
    const message =
      "moka submit: failed to set Workflow ownerReference for ConfigMaps after " +
      `Argo Workflow '${input.result.workflowName}' was created; ` +
      `leaving ConfigMaps for TTL/sweeper cleanup: ${reason}\n`;
    process.stderr.write(message);
  });
}

function cleanupRunConfigMapsOnFailure(input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  error: unknown;
  namespace: string;
  options: KubernetesArgoClientOptions;
}): Effect.Effect<never, unknown, KubernetesArgoService> {
  return deleteRunConfigMaps({
    configMapNames: input.configMapNames,
    dependencies: input.dependencies,
    namespace: input.namespace,
    options: input.options,
  }).pipe(
    Effect.catch((cleanupError) =>
      Effect.fail(
        new Error(
          `Failed to clean up ConfigMaps after submit failure: ${errorMessage(input.error)}; cleanup failed: ${errorMessage(cleanupError)}`
        )
      )
    ),
    Effect.flatMap(() => Effect.fail(input.error))
  );
}

function patchRunConfigMapOwnerReferences(input: {
  body: ConfigMapOwnerReferencesPatch;
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
}): Effect.Effect<unknown, unknown, KubernetesArgoService> {
  return Effect.gen(function* () {
    const service = yield* KubernetesArgoService;
    return yield* Effect.all(
      input.configMapNames.map((name) =>
        service.patchConfigMapOwnerReferences({
          body: input.body,
          dependencies: input.dependencies,
          name,
          namespace: input.namespace,
          options: input.options,
        })
      ),
      { concurrency: "unbounded" }
    );
  });
}

function deleteRunConfigMaps(input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
}): Effect.Effect<unknown, unknown, KubernetesArgoService> {
  return Effect.gen(function* () {
    const service = yield* KubernetesArgoService;
    return yield* Effect.all(
      input.configMapNames.map((name) =>
        service.deleteConfigMap({
          dependencies: input.dependencies,
          name,
          namespace: input.namespace,
          options: input.options,
        })
      ),
      { concurrency: "unbounded" }
    );
  });
}

function workflowOwnerReference(
  result: SubmitRunnerArgoWorkflowResult
): KubernetesOwnerReference | undefined {
  if (result.workflowUid === undefined) {
    return undefined;
  }
  return workflowOwnerReferenceSchema.parse({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Workflow",
    name: result.workflowName,
    uid: result.workflowUid,
  });
}

function missingWorkflowUidMessage(
  result: SubmitRunnerArgoWorkflowResult
): string {
  return `Created Argo Workflow '${result.workflowName}' did not include metadata.uid; cannot own ConfigMaps`;
}

function configMapOwnerReferencesPatch(
  ownerReference: KubernetesOwnerReference
): ConfigMapOwnerReferencesPatch {
  return configMapOwnerReferencesPatchSchema.parse({
    metadata: { ownerReferences: [ownerReference] },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function submitWorkflowManifest(input: {
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
  resultExtras: Omit<
    SubmitRunnerArgoWorkflowResult,
    "namespace" | "workflowName" | "workflowUid"
  >;
  workflow: ArgoWorkflowManifest;
  workflowFieldOverrides?: {
    podGC?: ArgoWorkflowPodGC;
  };
}): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> {
  return Effect.gen(function* () {
    const service = yield* KubernetesArgoService;
    const workflow = applyWorkflowFieldOverrides(
      input.workflow,
      input.workflowFieldOverrides
    );
    const response = yield* service.createWorkflow({
      body: runnerArgoWorkflowManifestSchema.parse(workflow),
      dependencies: input.dependencies,
      namespace: input.namespace,
      options: input.options,
    });
    return workflowSubmitResult(response, workflow, {
      namespace: input.namespace,
      ...input.resultExtras,
    });
  });
}

function submitWorkflowWithRunConfigMaps(input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
  resultExtras: Omit<
    SubmitRunnerArgoWorkflowResult,
    "namespace" | "workflowName" | "workflowUid"
  >;
  workflow: ArgoWorkflowManifest;
  workflowFieldOverrides?: {
    podGC?: ArgoWorkflowPodGC;
  };
}): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> {
  return submitWorkflowManifest({
    dependencies: input.dependencies,
    namespace: input.namespace,
    options: input.options,
    resultExtras: input.resultExtras,
    workflow: input.workflow,
    workflowFieldOverrides: input.workflowFieldOverrides,
  }).pipe(
    Effect.catch((error) =>
      cleanupRunConfigMapsOnFailure({
        configMapNames: input.configMapNames,
        dependencies: input.dependencies,
        error,
        namespace: input.namespace,
        options: input.options,
      })
    ),
    Effect.flatMap((result) =>
      ownRunConfigMapsBestEffort({
        configMapNames: input.configMapNames,
        dependencies: input.dependencies,
        namespace: input.namespace,
        options: input.options,
        result,
      })
    )
  );
}

function applyWorkflowFieldOverrides(
  workflow: ArgoWorkflowManifest,
  overrides: { podGC?: ArgoWorkflowPodGC } | undefined
): ArgoWorkflowManifest {
  if (overrides?.podGC === undefined) {
    return workflow;
  }
  return runnerArgoWorkflowManifestSchema.parse({
    ...workflow,
    spec: {
      ...workflow.spec,
      podGC: overrides.podGC,
    },
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
  const artifact: ScheduleArtifact = {
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
  };
  return stringify(
    appendPullRequestDelivery(options.deliverPullRequest, artifact)
  );
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
