import * as Schema from "effect/Schema";

import type { WorkflowExecutionPlan } from "../../planning/compile";
import {
  mutableArray,
  nonEmptyMutableArray,
  nonNegativeInteger,
  positiveInteger,
  requiredString,
  stringRecord,
  withDefault,
  urlString,
  struct,
} from "../../schema-boundary";
import {
  RUNNER_WORKFLOW_ENTRYPOINT,
  RUNNER_WORKFLOW_IMAGE,
  RUNNER_WORKFLOW_SERVICE_ACCOUNT,
} from "./policy";

const ARGO_WORKFLOW_API_VERSION = "argoproj.io/v1alpha1";
const ARGO_WORKFLOW_KIND = "Workflow";
const kubernetesNameSchema = requiredString;

export const dbAuthOptionSchema = struct({
  secretKey: withDefault(requiredString, "db-url"),
  secretName: kubernetesNameSchema,
});

export const mcpGatewayAuthOptionSchema = struct({
  secretKey: withDefault(requiredString, "pipeline-mcp-gateway-authorization"),
  secretName: kubernetesNameSchema,
});

const labelValueSchema = requiredString;
const optionalStringRecord = Schema.Record(
  requiredString,
  Schema.UndefinedOr(requiredString)
);

export const argoWorkflowActiveDeadlineSecondsSchema = nonNegativeInteger;

export const argoWorkflowTtlStrategySchema = struct({
  secondsAfterCompletion: Schema.optional(nonNegativeInteger),
  secondsAfterFailure: Schema.optional(nonNegativeInteger),
  secondsAfterSuccess: Schema.optional(nonNegativeInteger),
});

const argoWorkflowLabelSelectorRequirementSchema = struct({
  key: requiredString,
  operator: Schema.Literals(["In", "NotIn", "Exists", "DoesNotExist"]),
  values: Schema.optional(mutableArray(Schema.String)),
});

const argoWorkflowLabelSelectorSchema = struct({
  matchExpressions: Schema.optional(
    mutableArray(argoWorkflowLabelSelectorRequirementSchema)
  ),
  matchLabels: Schema.optional(Schema.Record(requiredString, Schema.String)),
});

export const argoWorkflowPodGcSchema = struct({
  deleteDelayDuration: Schema.optional(requiredString),
  labelSelector: Schema.optional(argoWorkflowLabelSelectorSchema),
  strategy: Schema.optional(
    Schema.Literals([
      "OnPodCompletion",
      "OnPodSuccess",
      "OnWorkflowCompletion",
      "OnWorkflowSuccess",
    ])
  ),
});

const keyPathItemSchema = struct({
  key: requiredString,
  path: requiredString,
});

const configMapVolumeSchema = struct({
  items: mutableArray(keyPathItemSchema),
  name: kubernetesNameSchema,
});

const secretVolumeSchema = struct({
  defaultMode: Schema.optional(positiveInteger),
  items: Schema.optional(mutableArray(keyPathItemSchema)),
  optional: Schema.optional(Schema.Boolean),
  secretName: kubernetesNameSchema,
});

export const argoWorkflowVolumeSchema = struct({
  configMap: Schema.optional(configMapVolumeSchema),
  name: kubernetesNameSchema,
  secret: Schema.optional(secretVolumeSchema),
}).check(
  Schema.makeFilter(
    (volume) =>
      volume.configMap !== undefined ||
      volume.secret !== undefined ||
      "Workflow volumes must declare configMap or secret",
    {
      description: "Argo workflow volume must reference a ConfigMap or Secret.",
      identifier: "ArgoWorkflowVolumeSource",
      title: "Argo workflow volume source",
    }
  )
);

export const argoWorkflowVolumeMountSchema = struct({
  mountPath: requiredString,
  name: kubernetesNameSchema,
  readOnly: Schema.optional(Schema.Boolean),
  subPath: Schema.optional(requiredString),
});

const argoWorkflowResourceRequirementsSchema = struct({
  limits: Schema.optional(stringRecord),
  requests: Schema.optional(stringRecord),
});

const argoWorkflowArtifactSchema = struct({
  from: Schema.optional(requiredString),
  name: requiredString,
  path: Schema.optional(requiredString),
});

const argoWorkflowParameterArgumentSchema = struct({
  name: requiredString,
  value: Schema.String,
});

const argoWorkflowParameterOutputSchema = struct({
  name: requiredString,
  valueFrom: struct({
    path: requiredString,
  }),
});

const argoWorkflowRetryStrategySchema = struct({
  expression: Schema.optional(requiredString),
  limit: Schema.optional(requiredString),
  retryPolicy: Schema.Literals([
    "Always",
    "OnError",
    "OnFailure",
    "OnTransientError",
  ]),
});

const argoWorkflowEnvVar = Schema.Union([
  struct({ name: requiredString, value: Schema.String }),
  struct({
    name: requiredString,
    valueFrom: struct({
      secretKeyRef: struct({
        key: requiredString,
        name: kubernetesNameSchema,
      }),
    }),
  }),
]);

const argoWorkflowDagTaskSchema = struct({
  arguments: Schema.optional(
    struct({
      artifacts: Schema.optional(mutableArray(argoWorkflowArtifactSchema)),
      parameters: Schema.optional(
        mutableArray(argoWorkflowParameterArgumentSchema)
      ),
    })
  ),
  dependencies: Schema.optional(mutableArray(requiredString)),
  name: requiredString,
  template: requiredString,
  when: Schema.optional(requiredString),
  withParam: Schema.optional(requiredString),
});

const argoWorkflowStepTaskSchema = struct({
  arguments: Schema.optional(
    struct({
      parameters: Schema.optional(
        mutableArray(argoWorkflowParameterArgumentSchema)
      ),
    })
  ),
  name: requiredString,
  template: requiredString,
  when: Schema.optional(requiredString),
  withParam: Schema.optional(requiredString),
});

const argoWorkflowTemplateSchema = struct({
  activeDeadlineSeconds: Schema.optional(positiveInteger),
  container: Schema.optional(
    struct({
      args: nonEmptyMutableArray(requiredString),
      command: Schema.optional(nonEmptyMutableArray(requiredString)),
      env: Schema.optional(mutableArray(argoWorkflowEnvVar)),
      image: requiredString,
      imagePullPolicy: Schema.Literals(["Always", "IfNotPresent", "Never"]),
      name: Schema.optional(requiredString),
      resources: Schema.optional(argoWorkflowResourceRequirementsSchema),
      volumeMounts: mutableArray(argoWorkflowVolumeMountSchema),
    })
  ),
  dag: Schema.optional(
    struct({
      tasks: nonEmptyMutableArray(argoWorkflowDagTaskSchema),
    })
  ),
  inputs: Schema.optional(
    struct({
      artifacts: Schema.optional(mutableArray(argoWorkflowArtifactSchema)),
      parameters: Schema.optional(
        mutableArray(struct({ name: requiredString }))
      ),
    })
  ),
  name: requiredString,
  outputs: Schema.optional(
    struct({
      artifacts: Schema.optional(mutableArray(argoWorkflowArtifactSchema)),
      parameters: Schema.optional(
        mutableArray(argoWorkflowParameterOutputSchema)
      ),
    })
  ),
  retryStrategy: Schema.optional(argoWorkflowRetryStrategySchema),
  steps: Schema.optional(
    mutableArray(mutableArray(argoWorkflowStepTaskSchema))
  ),
}).check(
  Schema.makeFilter(
    (template) =>
      template.container !== undefined ||
      template.dag !== undefined ||
      template.steps !== undefined ||
      "Workflow templates must declare container, dag, or steps",
    {
      description: "Argo template must declare one executable body.",
      identifier: "ArgoWorkflowTemplateBody",
      title: "Argo workflow template body",
    }
  )
);

export const createRunnerArgoWorkflowManifestSchema = () =>
  struct({
    apiVersion: Schema.Literal(ARGO_WORKFLOW_API_VERSION),
    kind: Schema.Literal(ARGO_WORKFLOW_KIND),
    metadata: struct({
      annotations: Schema.optional(stringRecord),
      generateName: Schema.optional(requiredString),
      labels: Schema.optional(Schema.Record(requiredString, labelValueSchema)),
      name: Schema.optional(requiredString),
      namespace: kubernetesNameSchema,
    }).check(
      Schema.makeFilter(
        (metadata) =>
          metadata.name !== undefined ||
          metadata.generateName !== undefined ||
          "Workflow metadata must declare name or generateName",
        {
          description:
            "Argo workflow metadata must include name or generateName.",
          identifier: "ArgoWorkflowMetadataName",
          title: "Argo workflow metadata name",
        }
      )
    ),
    spec: struct({
      activeDeadlineSeconds: Schema.optional(
        argoWorkflowActiveDeadlineSecondsSchema
      ),
      entrypoint: Schema.Literal(RUNNER_WORKFLOW_ENTRYPOINT),
      imagePullSecrets: Schema.optional(
        mutableArray(struct({ name: kubernetesNameSchema }))
      ),
      onExit: Schema.optional(requiredString),
      podGC: Schema.optional(argoWorkflowPodGcSchema),
      podMetadata: Schema.optional(
        struct({
          labels: Schema.optional(
            Schema.Record(requiredString, labelValueSchema)
          ),
        })
      ),
      serviceAccountName: kubernetesNameSchema,
      templates: nonEmptyMutableArray(argoWorkflowTemplateSchema),
      ttlStrategy: Schema.optional(argoWorkflowTtlStrategySchema),
      volumes: nonEmptyMutableArray(argoWorkflowVolumeSchema),
    }),
  });

const runnerWorkflowBrokerAuthSchema = struct({
  secretKey: withDefault(requiredString, "api-key"),
  secretName: kubernetesNameSchema,
  url: withDefault(urlString, "https://cliproxy.momokaya.ee"),
});

const runnerArgoWorkflowBaseOptionFields = {
  activeDeadlineSeconds: Schema.optional(
    argoWorkflowActiveDeadlineSecondsSchema
  ),
  annotations: withDefault(optionalStringRecord, {}),
  brokerAuth: runnerWorkflowBrokerAuthSchema,
  dbAuth: Schema.optional(dbAuthOptionSchema),
  eventAuthSecretKey: Schema.optional(requiredString),
  eventAuthSecretName: Schema.optional(kubernetesNameSchema),
  generateName: Schema.optional(requiredString),
  gitCredentialsSecretName: Schema.optional(kubernetesNameSchema),
  githubAuthSecretName: Schema.optional(kubernetesNameSchema),
  image: withDefault(requiredString, RUNNER_WORKFLOW_IMAGE),
  imagePullPolicy: withDefault(
    Schema.Literals(["Always", "IfNotPresent", "Never"]),
    "Always"
  ),
  imagePullSecretName: Schema.optional(kubernetesNameSchema),
  labels: withDefault(optionalStringRecord, {}),
  mcpGatewayAuth: Schema.optional(mcpGatewayAuthOptionSchema),
  name: Schema.optional(requiredString),
  namespace: kubernetesNameSchema,
  npmRegistryAuthSecretName: Schema.optional(kubernetesNameSchema),
  payloadConfigMapKey: withDefault(requiredString, "payload.json"),
  payloadConfigMapName: kubernetesNameSchema,
  resources: Schema.optional(argoWorkflowResourceRequirementsSchema),
  serviceAccountName: withDefault(
    kubernetesNameSchema,
    RUNNER_WORKFLOW_SERVICE_ACCOUNT
  ),
  ttlStrategy: Schema.optional(argoWorkflowTtlStrategySchema),
};

const hasWorkflowName = (options: {
  readonly generateName?: string;
  readonly name?: string;
}): boolean => options.name !== undefined || options.generateName !== undefined;

export const buildRunnerArgoWorkflowOptionsSchema = struct({
  ...runnerArgoWorkflowBaseOptionFields,
  scheduleConfigMapKey: withDefault(requiredString, "schedule.yaml"),
  scheduleConfigMapName: kubernetesNameSchema,
  taskDescriptorConfigMapName: kubernetesNameSchema,
}).check(
  Schema.makeFilter(
    (options) =>
      hasWorkflowName(options) ||
      "Runner Workflow options must declare name or generateName",
    {
      description:
        "Runner workflow build options must include name or generateName.",
      identifier: "BuildRunnerArgoWorkflowName",
      title: "Build runner Argo workflow name",
    }
  )
);

export const buildDynamicRunnerArgoWorkflowOptionsSchema = struct({
  ...runnerArgoWorkflowBaseOptionFields,
  workflowId: requiredString,
}).check(
  Schema.makeFilter(
    (options) =>
      hasWorkflowName(options) ||
      "Runner Workflow options must declare name or generateName",
    {
      description:
        "Dynamic runner workflow build options must include name or generateName.",
      identifier: "BuildDynamicRunnerArgoWorkflowName",
      title: "Build dynamic runner Argo workflow name",
    }
  )
);

export type ArgoWorkflowEnvVar = typeof argoWorkflowEnvVar.Type;
export type ArgoWorkflowPodGC = typeof argoWorkflowPodGcSchema.Type;
export type ArgoWorkflowResourceRequirements =
  typeof argoWorkflowResourceRequirementsSchema.Type;
export type ArgoWorkflowRetryStrategy =
  typeof argoWorkflowRetryStrategySchema.Type;
export type ArgoWorkflowTemplate = typeof argoWorkflowTemplateSchema.Type;
export type ArgoWorkflowTtlStrategy = typeof argoWorkflowTtlStrategySchema.Type;
export type ArgoWorkflowVolume = typeof argoWorkflowVolumeSchema.Type;
export type ArgoWorkflowVolumeMount = typeof argoWorkflowVolumeMountSchema.Type;
export type ParsedBuildRunnerArgoWorkflowOptions =
  typeof buildRunnerArgoWorkflowOptionsSchema.Type & {
    plan: WorkflowExecutionPlan;
  };
export type ParsedBuildDynamicRunnerArgoWorkflowOptions =
  typeof buildDynamicRunnerArgoWorkflowOptionsSchema.Type;
