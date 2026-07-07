import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { stringify } from "yaml";

import {
  ArgoGraphCompilerError,
  compileArgoExecutionGraph,
} from "./argo-graph";
import {
  buildDynamicRunnerArgoWorkflowManifest,
  buildRunnerArgoWorkflowManifest,
  runnerArgoWorkflowManifestSchema,
} from "./argo-workflow";
import type { ArgoWorkflowManifest } from "./argo-workflow";
import type { PipelineConfig } from "./config";
import { normalizeRunnerRepositoryForSubmit } from "./git-remote-url";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "./planning/generate";
import type {
  CompiledScheduleArtifact,
  ScheduleArtifact,
} from "./planning/generate";
import type { ArgoWorkflowPodGC } from "./remote/argo/model";
import { runnerPodSubmitOptionShape } from "./remote/submit/options";
import {
  parseRunnerCommandPayload,
  runnerCommandPayloadSchema,
} from "./runner-command-contract";
import type { RunnerCommandPayload } from "./runner-command-contract";
import { buildRunnerTaskDescriptor } from "./runner-command/task-descriptor";
import {
  KubernetesArgoService,
  KubernetesArgoServiceLive,
} from "./runtime/services/kubernetes-argo-service";
import type {
  ConfigMapOwnerReferencesPatch,
  CoreApi,
  KubernetesArgoClientOptions,
  KubernetesArgoIoDependencies,
  KubernetesOwnerReference,
  WorkflowApi,
} from "./runtime/services/kubernetes-argo-service";
import { appendPullRequestDelivery } from "./schedule/passes/open-pull-request";
import {
  nonEmptyMutableArray,
  parseStrictWithSchema,
  parseWithSchema,
  requiredString,
  stringRecord,
  withDefault,
  struct,
} from "./schema-boundary";
import { workflowSubmitResultSchema } from "./workflow-submit-contract";

const scheduleId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/u));

type StringRecord = Readonly<Record<string, string>>;

const configMapSchema = struct({
  apiVersion: Schema.Literal("v1"),
  data: stringRecord,
  kind: Schema.Literal("ConfigMap"),
  metadata: struct({
    labels: Schema.optional(stringRecord),
    name: requiredString,
    namespace: requiredString,
  }),
});

const workflowOwnerReferenceSchema = struct({
  apiVersion: Schema.Literal("argoproj.io/v1alpha1"),
  kind: Schema.Literal("Workflow"),
  name: requiredString,
  uid: requiredString,
});

const configMapOwnerReferencesPatchSchema = struct({
  metadata: struct({
    ownerReferences: Schema.mutable(
      Schema.Tuple([workflowOwnerReferenceSchema])
    ),
  }),
});

const createdWorkflowSchema = struct({
  metadata: struct({
    name: Schema.optional(requiredString),
    uid: Schema.optional(requiredString),
  }),
});

const runnerTaskDescriptorJson = Schema.fromJsonString(
  struct({ nodeId: requiredString })
);
const encodeRunnerTaskDescriptorJson = Schema.encodeSync(
  runnerTaskDescriptorJson
);
const runnerCommandPayloadJson = Schema.fromJsonString(
  runnerCommandPayloadSchema
);
const encodeRunnerCommandPayloadJson = Schema.encodeSync(
  runnerCommandPayloadJson
);
const errorMessageShape = struct({ message: Schema.String });

const randomHex = (byteLength: number): string =>
  globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, byteLength * 2);

class ArgoSubmitError extends Schema.TaggedErrorClass<ArgoSubmitError>()(
  "ArgoSubmitError",
  {
    message: Schema.String,
  }
) {}

const submitRunnerArgoWorkflowBaseOptionShape = {
  ...runnerPodSubmitOptionShape,
  imagePullPolicy: Schema.optional(
    Schema.Literals(["Always", "IfNotPresent", "Never"])
  ),
  namespace: requiredString,
  payloadJson: requiredString,
};

const commandScheduleOptionsSchema = struct({
  command: nonEmptyMutableArray(requiredString),
  deliverPullRequest: withDefault(Schema.Boolean, false),
  generatedAt: Schema.optional(Schema.DateTimeUtcFromDate),
  scheduleId: Schema.optional(scheduleId),
  task: requiredString,
});

const hasWorkflowName = (options: {
  generateName?: string;
  name?: string;
}): boolean => options.name !== undefined || options.generateName !== undefined;

const submitRunnerArgoWorkflowOptionsSchema = struct({
  ...submitRunnerArgoWorkflowBaseOptionShape,
  scheduleYaml: requiredString,
}).check(
  Schema.makeFilter(
    (options) =>
      hasWorkflowName(options) ||
      "Argo submit options must declare name or generateName",
    {
      description:
        "Static Argo submit options must include name or generateName.",
      identifier: "SubmitRunnerArgoWorkflowName",
      title: "Submit runner Argo workflow name",
    }
  )
);

const submitDynamicRunnerArgoWorkflowOptionsSchema = struct({
  ...submitRunnerArgoWorkflowBaseOptionShape,
  workflowId: requiredString,
}).check(
  Schema.makeFilter(
    (options) =>
      hasWorkflowName(options) ||
      "Argo submit options must declare name or generateName",
    {
      description:
        "Dynamic Argo submit options must include name or generateName.",
      identifier: "SubmitDynamicRunnerArgoWorkflowName",
      title: "Submit dynamic runner Argo workflow name",
    }
  )
);

export type SubmitRunnerArgoWorkflowOptions =
  typeof submitRunnerArgoWorkflowOptionsSchema.Encoded & {
    config: PipelineConfig;
  };
export type SubmitRunnerArgoWorkflowResult =
  typeof workflowSubmitResultSchema.Type;
export type CommandScheduleOptions =
  typeof commandScheduleOptionsSchema.Encoded;

export interface SubmitRunnerArgoWorkflowDependencies {
  coreApi?: CoreApi;
  kubeConfig?: KubernetesArgoIoDependencies["kubeConfig"];
  workflowApi?: WorkflowApi;
}

export type SubmitDynamicRunnerArgoWorkflowOptions =
  typeof submitDynamicRunnerArgoWorkflowOptionsSchema.Encoded & {
    config: PipelineConfig;
  };

const kubernetesArgoRuntime = ManagedRuntime.make(KubernetesArgoServiceLive);

const runKubernetesArgoEffect = async <A, E>(
  effect: Effect.Effect<A, E, KubernetesArgoService>
): Promise<A> => await kubernetesArgoRuntime.runPromise(effect);

type ConfigMapManifest = typeof configMapSchema.Type;

interface RunConfigMapSpec {
  readonly body: ConfigMapManifest;
  readonly name: string;
}

interface RunConfigMapOperationInput {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
}

interface PatchRunConfigMapOwnerReferencesInput extends RunConfigMapOperationInput {
  body: ConfigMapOwnerReferencesPatch;
}

const runConfigMap = (input: {
  data: StringRecord;
  labels: StringRecord;
  name: string;
  namespace: string;
}): RunConfigMapSpec => {
  const body = parseStrictWithSchema(configMapSchema, {
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
};

const staticRunConfigMaps = (input: {
  labels: StringRecord;
  namespace: string;
  payloadConfigMapName: string;
  payloadJson: string;
  scheduleConfigMapName: string;
  scheduleYaml: string;
  taskDescriptorConfigMapName: string;
  tasks: ReturnType<typeof compileArgoExecutionGraph>["tasks"];
}): readonly RunConfigMapSpec[] => [
  runConfigMap({
    data: { "payload.json": input.payloadJson },
    labels: input.labels,
    name: input.payloadConfigMapName,
    namespace: input.namespace,
  }),
  runConfigMap({
    data: R.fromEntries(
      input.tasks.map((task) => [
        `${task.taskName}.json`,
        `${encodeRunnerTaskDescriptorJson(buildRunnerTaskDescriptor(task.nodeId))}\n`,
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

const dynamicRunConfigMaps = (input: {
  labels: StringRecord;
  namespace: string;
  payloadConfigMapName: string;
  payloadJson: string;
}): readonly RunConfigMapSpec[] => [
  runConfigMap({
    data: { "payload.json": input.payloadJson },
    labels: input.labels,
    name: input.payloadConfigMapName,
    namespace: input.namespace,
  }),
];

const runConfigMapEffects = (
  configMapNames: readonly string[],
  effectForName: (name: string) => Effect.Effect<unknown, unknown>
): Effect.Effect<unknown, unknown> =>
  Effect.all(configMapNames.map(effectForName), { concurrency: "unbounded" });

const patchRunConfigMapOwnerReferences = (
  input: PatchRunConfigMapOwnerReferencesInput
): Effect.Effect<unknown, unknown, KubernetesArgoService> =>
  Effect.gen(function* effectBody() {
    const service = yield* KubernetesArgoService;
    yield* runConfigMapEffects(input.configMapNames, (name) =>
      service.patchConfigMapOwnerReferences({
        body: input.body,
        dependencies: input.dependencies,
        name,
        namespace: input.namespace,
        options: input.options,
      })
    );
  });

const deleteRunConfigMaps = (
  input: RunConfigMapOperationInput
): Effect.Effect<unknown, unknown, KubernetesArgoService> =>
  Effect.gen(function* effectBody() {
    const service = yield* KubernetesArgoService;
    yield* runConfigMapEffects(input.configMapNames, (name) =>
      service.deleteConfigMap({
        dependencies: input.dependencies,
        name,
        namespace: input.namespace,
        options: input.options,
      })
    );
  });

const workflowOwnerReference = (
  result: SubmitRunnerArgoWorkflowResult
): Option.Option<KubernetesOwnerReference> => {
  if (result.workflowUid === undefined) {
    return Option.none();
  }
  return Option.some(
    parseStrictWithSchema(workflowOwnerReferenceSchema, {
      apiVersion: "argoproj.io/v1alpha1",
      kind: "Workflow",
      name: result.workflowName,
      uid: result.workflowUid,
    })
  );
};

const missingWorkflowUidMessage = (
  result: SubmitRunnerArgoWorkflowResult
): string =>
  `Created Argo Workflow '${result.workflowName}' did not include metadata.uid; cannot own ConfigMaps`;

const configMapOwnerReferencesPatch = (
  ownerReference: KubernetesOwnerReference
): ConfigMapOwnerReferencesPatch =>
  parseStrictWithSchema(configMapOwnerReferencesPatchSchema, {
    metadata: { ownerReferences: [ownerReference] },
  });

const errorMessage = (error: unknown): string =>
  Option.match(Schema.decodeUnknownOption(errorMessageShape)(error), {
    onNone: () => String(error),
    onSome: (value) => value.message,
  });

const warnRunConfigMapOwnershipSkipped = (input: {
  error: unknown;
  result: SubmitRunnerArgoWorkflowResult;
}): Effect.Effect<void> =>
  Effect.sync(() => {
    const reason = errorMessage(input.error);
    const message =
      "moka submit: failed to set Workflow ownerReference for ConfigMaps after " +
      `Argo Workflow '${input.result.workflowName}' was created; ` +
      `leaving ConfigMaps for TTL/sweeper cleanup: ${reason}\n`;
    process.stderr.write(message);
  });

const ownRunConfigMaps = (input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
  result: SubmitRunnerArgoWorkflowResult;
}): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> => {
  const ownerReference = workflowOwnerReference(input.result);
  if (Option.isNone(ownerReference)) {
    return warnRunConfigMapOwnershipSkipped({
      error: new ArgoSubmitError({
        message: missingWorkflowUidMessage(input.result),
      }),
      result: input.result,
    }).pipe(Effect.as(input.result));
  }
  const body = configMapOwnerReferencesPatch(ownerReference.value);
  return patchRunConfigMapOwnerReferences({
    body,
    configMapNames: input.configMapNames,
    dependencies: input.dependencies,
    namespace: input.namespace,
    options: input.options,
  }).pipe(Effect.as(input.result));
};

const ownRunConfigMapsBestEffort = (input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
  result: SubmitRunnerArgoWorkflowResult;
}): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  never,
  KubernetesArgoService
> =>
  ownRunConfigMaps(input).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        warnRunConfigMapOwnershipSkipped({
          error,
          result: input.result,
        }).pipe(Effect.as(input.result)),
      onSuccess: (result) => Effect.succeed(result),
    })
  );

const cleanupRunConfigMapsOnFailure = (input: {
  configMapNames: readonly string[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  error: unknown;
  namespace: string;
  options: KubernetesArgoClientOptions;
}): Effect.Effect<never, unknown, KubernetesArgoService> =>
  deleteRunConfigMaps({
    configMapNames: input.configMapNames,
    dependencies: input.dependencies,
    namespace: input.namespace,
    options: input.options,
  }).pipe(
    Effect.matchEffect({
      onFailure: (cleanupError) =>
        Effect.fail(
          new ArgoSubmitError({
            message: `Failed to clean up ConfigMaps after submit failure: ${errorMessage(input.error)}; cleanup failed: ${errorMessage(cleanupError)}`,
          })
        ),
      onSuccess: () => Effect.fail(input.error),
    })
  );

const createRunConfigMaps = (input: {
  configMaps: readonly RunConfigMapSpec[];
  dependencies: SubmitRunnerArgoWorkflowDependencies;
  namespace: string;
  options: KubernetesArgoClientOptions;
}): Effect.Effect<readonly string[], unknown, KubernetesArgoService> => {
  const createdConfigMapNames: string[] = [];
  return Effect.gen(function* effectBody() {
    const service = yield* KubernetesArgoService;
    yield* Effect.all(
      input.configMaps.map((configMap) =>
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
      ),
      { concurrency: "unbounded" }
    );
    return createdConfigMapNames;
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        cleanupRunConfigMapsOnFailure({
          configMapNames: createdConfigMapNames,
          dependencies: input.dependencies,
          error,
          namespace: input.namespace,
          options: input.options,
        }),
      onSuccess: (configMapNames) => Effect.succeed(configMapNames),
    })
  );
};

const applyWorkflowFieldOverrides = (
  workflow: ArgoWorkflowManifest,
  overrides: { podGC?: ArgoWorkflowPodGC } = {}
): ArgoWorkflowManifest => {
  if (overrides.podGC === undefined) {
    return workflow;
  }
  return parseStrictWithSchema(runnerArgoWorkflowManifestSchema, {
    ...workflow,
    spec: {
      ...workflow.spec,
      podGC: overrides.podGC,
    },
  });
};

const workflowSubmitResult = (
  response: unknown,
  workflow: ArgoWorkflowManifest,
  base: Omit<SubmitRunnerArgoWorkflowResult, "workflowName" | "workflowUid">
): SubmitRunnerArgoWorkflowResult => {
  const created = parseWithSchema(createdWorkflowSchema, response, {
    onExcessProperty: "preserve",
  });
  return parseStrictWithSchema(workflowSubmitResultSchema, {
    ...base,
    workflowName: created.metadata.name ?? workflow.metadata.name,
    workflowUid: created.metadata.uid,
  });
};

const submitWorkflowManifest = (input: {
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
> =>
  Effect.gen(function* effectBody() {
    const service = yield* KubernetesArgoService;
    const workflow = applyWorkflowFieldOverrides(
      input.workflow,
      input.workflowFieldOverrides
    );
    const response = yield* service.createWorkflow({
      body: parseStrictWithSchema(runnerArgoWorkflowManifestSchema, workflow),
      dependencies: input.dependencies,
      namespace: input.namespace,
      options: input.options,
    });
    return workflowSubmitResult(response, workflow, {
      namespace: input.namespace,
      ...input.resultExtras,
    });
  });

const submitWorkflowWithRunConfigMaps = (input: {
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
> =>
  submitWorkflowManifest({
    dependencies: input.dependencies,
    namespace: input.namespace,
    options: input.options,
    resultExtras: input.resultExtras,
    workflow: input.workflow,
    workflowFieldOverrides: input.workflowFieldOverrides,
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        cleanupRunConfigMapsOnFailure({
          configMapNames: input.configMapNames,
          dependencies: input.dependencies,
          error,
          namespace: input.namespace,
          options: input.options,
        }),
      onSuccess: (result) =>
        ownRunConfigMapsBestEffort({
          configMapNames: input.configMapNames,
          dependencies: input.dependencies,
          namespace: input.namespace,
          options: input.options,
          result,
        }),
    })
  );

export const buildCommandScheduleYaml = (
  rawOptions: CommandScheduleOptions
): string => {
  const options = parseStrictWithSchema(
    commandScheduleOptionsSchema,
    rawOptions
  );
  const commandScheduleId = options.scheduleId ?? `custom-${randomHex(8)}`;
  const generatedAt = options.generatedAt ?? DateTime.nowUnsafe();
  const artifact: ScheduleArtifact = {
    generated_at: DateTime.formatIso(generatedAt),
    kind: "pipeline-schedule",
    root_workflow: "root",
    schedule_id: commandScheduleId,
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
};

const normalizeRunnerPayloadForSubmit = (input: {
  payload: RunnerCommandPayload;
  payloadJson: string;
}): { payload: RunnerCommandPayload; payloadJson: string } => {
  const repository = normalizeRunnerRepositoryForSubmit(
    input.payload.repository
  );
  if (repository === input.payload.repository) {
    return input;
  }
  const payload = parseStrictWithSchema(runnerCommandPayloadSchema, {
    ...input.payload,
    repository,
  });
  return { payload, payloadJson: encodeRunnerCommandPayloadJson(payload) };
};

const submitDynamicRunnerArgoWorkflowEffect = (
  rawOptions: SubmitDynamicRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies
): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> => {
  const { config: _config, ...schemaOptions } = rawOptions;
  const options = parseStrictWithSchema(
    submitDynamicRunnerArgoWorkflowOptionsSchema,
    schemaOptions
  );
  const parsedPayload = parseStrictWithSchema(
    runnerCommandPayloadSchema,
    parseRunnerCommandPayload(options.payloadJson)
  );
  const { payload, payloadJson } = normalizeRunnerPayloadForSubmit({
    payload: parsedPayload,
    payloadJson: options.payloadJson,
  });
  if (payload.workflow.id !== options.workflowId) {
    return Effect.fail(
      new ArgoSubmitError({
        message: `Runner payload workflow '${payload.workflow.id}' does not match dynamic workflow '${options.workflowId}'`,
      })
    );
  }
  const payloadConfigMapName = `pipeline-payload-${randomHex(6)}`;
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
    labels,
    mcpGatewayAuth: options.mcpGatewayAuth,
    name: options.name,
    namespace: options.namespace,
    npmRegistryAuthSecretName: options.npmRegistryAuthSecretName,
    payloadConfigMapName,
    serviceAccountName: options.serviceAccountName,
    ttlStrategy: options.ttlStrategy,
    workflowId: options.workflowId,
  });
  return Effect.gen(function* effectBody() {
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
};

export const submitDynamicRunnerArgoWorkflow = async (
  rawOptions: SubmitDynamicRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies = {}
): Promise<SubmitRunnerArgoWorkflowResult> =>
  await runKubernetesArgoEffect(
    Effect.suspend(() =>
      submitDynamicRunnerArgoWorkflowEffect(rawOptions, dependencies)
    )
  );

const compileSubmitArgoGraph = (
  compiled: CompiledScheduleArtifact
): Effect.Effect<
  ReturnType<typeof compileArgoExecutionGraph>,
  ArgoGraphCompilerError
> =>
  Effect.try({
    catch: (error) => {
      if (error instanceof ArgoGraphCompilerError) {
        return error;
      }
      throw error;
    },
    try: () => compileArgoExecutionGraph(compiled.plan),
  });

const submitRunnerArgoWorkflowEffect = (
  rawOptions: SubmitRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies
): Effect.Effect<
  SubmitRunnerArgoWorkflowResult,
  unknown,
  KubernetesArgoService
> => {
  const { config, ...schemaOptions } = rawOptions;
  const options = parseStrictWithSchema(
    submitRunnerArgoWorkflowOptionsSchema,
    schemaOptions
  );
  const parsedPayload = parseStrictWithSchema(
    runnerCommandPayloadSchema,
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
  const payloadConfigMapName = `pipeline-payload-${randomHex(6)}`;
  const scheduleArtifactConfigMapName = `pipeline-schedule-${randomHex(6)}`;
  const taskDescriptorConfigMapName = `pipeline-task-descriptors-${randomHex(6)}`;
  if (payload.workflow.id !== compiled.workflowId) {
    return Effect.fail(
      new ArgoSubmitError({
        message: `Runner payload workflow '${payload.workflow.id}' does not match schedule workflow '${compiled.workflowId}'`,
      })
    );
  }
  const graphEffect = compileSubmitArgoGraph(compiled).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.fail(
          new ArgoSubmitError({
            message: `Schedule '${compiled.workflowId}' cannot be submitted: ${error.message}`,
          })
        ),
      onSuccess: (graph) => Effect.succeed(graph),
    })
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
    labels,
    mcpGatewayAuth: options.mcpGatewayAuth,
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
  return Effect.gen(function* effectBody() {
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
};

export const submitRunnerArgoWorkflow = async (
  rawOptions: SubmitRunnerArgoWorkflowOptions,
  dependencies: SubmitRunnerArgoWorkflowDependencies = {}
): Promise<SubmitRunnerArgoWorkflowResult> =>
  await runKubernetesArgoEffect(
    Effect.suspend(() =>
      submitRunnerArgoWorkflowEffect(rawOptions, dependencies)
    )
  );
