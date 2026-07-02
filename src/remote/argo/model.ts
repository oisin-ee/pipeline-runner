import { z } from "zod";
import type { WorkflowExecutionPlan } from "../../planning/compile";
import {
  RUNNER_WORKFLOW_ENTRYPOINT,
  RUNNER_WORKFLOW_IMAGE,
  RUNNER_WORKFLOW_SERVICE_ACCOUNT,
} from "./policy";

const ARGO_WORKFLOW_API_VERSION = "argoproj.io/v1alpha1";
const ARGO_WORKFLOW_KIND = "Workflow";
const kubernetesNameSchema = z.string().min(1);

/**
 * PIPE-94.4: submit-time secret ref for MOKA_DB_URL injection in runner pods.
 * The single owner of the dbAuth option shape — the runner-workflow model,
 * argo-submit, and moka-submit all reference this rather than redeclaring it.
 * `secretKey` defaults to "db-url"; absent dbAuth → no MOKA_DB_URL env emitted.
 */
export const dbAuthOptionSchema = z
  .object({
    secretKey: z.string().min(1).default("db-url"),
    secretName: kubernetesNameSchema,
  })
  .strict();

/**
 * Submit-time secret ref for PIPELINE_MCP_GATEWAY_AUTHORIZATION injection in
 * runner pods. Lets runner-side agents reach the pipeline-gateway vMCP (the
 * verify-bot-authed browser-automation tools) the same way Coder dev-workspaces
 * do: the shared dotfiles opencode MCP config reads the gateway basic-auth
 * header from this env. The single owner of the option shape — the
 * runner-workflow model, argo-submit, and moka-submit all reference this rather
 * than redeclaring it. `secretKey` defaults to "pipeline-mcp-gateway-authorization"
 * (the ExternalSecret-projected key); absent mcpGatewayAuth → no env emitted.
 */
export const mcpGatewayAuthOptionSchema = z
  .object({
    secretKey: z.string().min(1).default("pipeline-mcp-gateway-authorization"),
    secretName: kubernetesNameSchema,
  })
  .strict();
const labelValueSchema = z.string().min(1);
const stringMapSchema = z.record(z.string().min(1), z.string().min(1));

export const argoWorkflowActiveDeadlineSecondsSchema = z
  .number()
  .int()
  .nonnegative();

export const argoWorkflowTtlStrategySchema = z
  .object({
    secondsAfterCompletion: z.number().int().nonnegative().optional(),
    secondsAfterFailure: z.number().int().nonnegative().optional(),
    secondsAfterSuccess: z.number().int().nonnegative().optional(),
  })
  .strict();

const argoWorkflowLabelSelectorRequirementSchema = z
  .object({
    key: z.string().min(1),
    operator: z.enum(["In", "NotIn", "Exists", "DoesNotExist"]),
    values: z.array(z.string()).optional(),
  })
  .strict();

const argoWorkflowLabelSelectorSchema = z
  .object({
    matchExpressions: z
      .array(argoWorkflowLabelSelectorRequirementSchema)
      .optional(),
    matchLabels: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict();

export const argoWorkflowPodGcSchema = z
  .object({
    deleteDelayDuration: z.string().min(1).optional(),
    labelSelector: argoWorkflowLabelSelectorSchema.optional(),
    strategy: z
      .enum([
        "OnPodCompletion",
        "OnPodSuccess",
        "OnWorkflowCompletion",
        "OnWorkflowSuccess",
      ])
      .optional(),
  })
  .strict();

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

export const argoWorkflowVolumeSchema = z
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

export const argoWorkflowVolumeMountSchema = z
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

const argoWorkflowParameterArgumentSchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
  })
  .strict();

const argoWorkflowParameterOutputSchema = z
  .object({
    name: z.string().min(1),
    valueFrom: z
      .object({
        path: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const argoWorkflowRetryStrategySchema = z
  .object({
    expression: z.string().min(1).optional(),
    limit: z.string().min(1).optional(),
    retryPolicy: z.enum(["Always", "OnError", "OnFailure", "OnTransientError"]),
  })
  .strict();

const argoWorkflowEnvVarSchema = z.union([
  z.object({ name: z.string().min(1), value: z.string() }).strict(),
  z
    .object({
      name: z.string().min(1),
      valueFrom: z
        .object({
          secretKeyRef: z
            .object({
              key: z.string().min(1),
              name: kubernetesNameSchema,
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
]);

const argoWorkflowTemplateSchema = z
  .object({
    container: z
      .object({
        args: z.array(z.string().min(1)).min(1),
        command: z.array(z.string().min(1)).min(1).optional(),
        env: z.array(argoWorkflowEnvVarSchema).optional(),
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
                arguments: z
                  .object({
                    artifacts: z.array(argoWorkflowArtifactSchema).optional(),
                    parameters: z
                      .array(argoWorkflowParameterArgumentSchema)
                      .optional(),
                  })
                  .strict()
                  .optional(),
                dependencies: z.array(z.string().min(1)).optional(),
                name: z.string().min(1),
                template: z.string().min(1),
                when: z.string().min(1).optional(),
                withParam: z.string().min(1).optional(),
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
        artifacts: z.array(argoWorkflowArtifactSchema).optional(),
        parameters: z.array(argoWorkflowParameterOutputSchema).optional(),
      })
      .strict()
      .optional(),
    steps: z
      .array(
        z.array(
          z
            .object({
              arguments: z
                .object({
                  parameters: z
                    .array(argoWorkflowParameterArgumentSchema)
                    .optional(),
                })
                .strict()
                .optional(),
              name: z.string().min(1),
              template: z.string().min(1),
              when: z.string().min(1).optional(),
              withParam: z.string().min(1).optional(),
            })
            .strict()
        )
      )
      .optional(),
    activeDeadlineSeconds: z.number().int().positive().optional(),
    name: z.string().min(1),
    retryStrategy: argoWorkflowRetryStrategySchema.optional(),
  })
  .strict()
  .refine(
    (template) =>
      template.container !== undefined ||
      template.dag !== undefined ||
      template.steps !== undefined,
    {
      message: "Workflow templates must declare container, dag, or steps",
    }
  );

export function createRunnerArgoWorkflowManifestSchema() {
  return z
    .object({
      apiVersion: z.literal(ARGO_WORKFLOW_API_VERSION),
      kind: z.literal(ARGO_WORKFLOW_KIND),
      metadata: z
        .object({
          annotations: z
            .record(z.string().min(1), z.string().min(1))
            .optional(),
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
          activeDeadlineSeconds:
            argoWorkflowActiveDeadlineSecondsSchema.optional(),
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
          podGC: argoWorkflowPodGcSchema.optional(),
          ttlStrategy: argoWorkflowTtlStrategySchema.optional(),
          volumes: z.array(argoWorkflowVolumeSchema).min(1),
        })
        .strict(),
    })
    .strict();
}

const runnerWorkflowBrokerAuthSchema = z
  .object({
    secretKey: z.string().min(1).default("api-key"),
    secretName: kubernetesNameSchema,
    url: z.string().min(1).default("https://cliproxy.momokaya.ee"),
  })
  .strict();

const runnerArgoWorkflowBaseOptionsSchema = z
  .object({
    activeDeadlineSeconds: argoWorkflowActiveDeadlineSecondsSchema.optional(),
    annotations: z
      .record(z.string().min(1), z.string().min(1).optional())
      .default({}),
    brokerAuth: runnerWorkflowBrokerAuthSchema,
    // PIPE-94.3: durable-substrate db.url injection for runner pods.
    // When present, MOKA_DB_URL is injected via secretKeyRef so loadMokaDbUrl()
    // resolves in-cluster without a config file mount.
    dbAuth: dbAuthOptionSchema.optional(),
    eventAuthSecretKey: z.string().min(1).optional(),
    eventAuthSecretName: kubernetesNameSchema.optional(),
    generateName: z.string().min(1).optional(),
    gitCredentialsSecretName: kubernetesNameSchema.optional(),
    githubAuthSecretName: kubernetesNameSchema.optional(),
    image: z.string().min(1).default(RUNNER_WORKFLOW_IMAGE),
    imagePullPolicy: z
      .enum(["Always", "IfNotPresent", "Never"])
      .default("Always"),
    imagePullSecretName: kubernetesNameSchema.optional(),
    labels: z
      .record(z.string().min(1), z.string().min(1).optional())
      .default({}),
    // Optional secret ref for PIPELINE_MCP_GATEWAY_AUTHORIZATION injection.
    // When present, the runner sources the gateway basic-auth header via
    // secretKeyRef so dotfiles' pipeline-gateway MCP entry resolves in-cluster.
    mcpGatewayAuth: mcpGatewayAuthOptionSchema.optional(),
    name: z.string().min(1).optional(),
    namespace: kubernetesNameSchema,
    // Optional secret ref for an .npmrc mounted at /root/.npmrc so the repo's
    // own bootstrap (.moka/bootstrap.sh -> nub install) can authenticate to
    // private-scoped package registries. Absent -> bootstrap only has access
    // to public registries, same as before this option existed.
    npmRegistryAuthSecretName: kubernetesNameSchema.optional(),
    payloadConfigMapKey: z.string().min(1).default("payload.json"),
    payloadConfigMapName: kubernetesNameSchema,
    resources: argoWorkflowResourceRequirementsSchema.optional(),
    serviceAccountName: kubernetesNameSchema.default(
      RUNNER_WORKFLOW_SERVICE_ACCOUNT
    ),
    ttlStrategy: argoWorkflowTtlStrategySchema.optional(),
  })
  .strict();

export const buildRunnerArgoWorkflowOptionsSchema =
  runnerArgoWorkflowBaseOptionsSchema
    .extend({
      scheduleConfigMapKey: z.string().min(1).default("schedule.yaml"),
      scheduleConfigMapName: kubernetesNameSchema,
      taskDescriptorConfigMapName: kubernetesNameSchema,
    })
    .strict()
    .refine(
      (options) =>
        options.name !== undefined || options.generateName !== undefined,
      {
        message: "Runner Workflow options must declare name or generateName",
      }
    );

export const buildDynamicRunnerArgoWorkflowOptionsSchema =
  runnerArgoWorkflowBaseOptionsSchema
    .extend({
      workflowId: z.string().min(1),
    })
    .strict()
    .refine(
      (options) =>
        options.name !== undefined || options.generateName !== undefined,
      {
        message: "Runner Workflow options must declare name or generateName",
      }
    );

export type ArgoWorkflowEnvVar = z.infer<typeof argoWorkflowEnvVarSchema>;
export type ArgoWorkflowPodGC = z.infer<typeof argoWorkflowPodGcSchema>;
export type ArgoWorkflowResourceRequirements = z.infer<
  typeof argoWorkflowResourceRequirementsSchema
>;
export type ArgoWorkflowRetryStrategy = z.infer<
  typeof argoWorkflowRetryStrategySchema
>;
export type ArgoWorkflowTemplate = z.infer<typeof argoWorkflowTemplateSchema>;
export type ArgoWorkflowTtlStrategy = z.infer<
  typeof argoWorkflowTtlStrategySchema
>;
export type ArgoWorkflowVolume = z.infer<typeof argoWorkflowVolumeSchema>;
export type ArgoWorkflowVolumeMount = z.infer<
  typeof argoWorkflowVolumeMountSchema
>;
export type ParsedBuildRunnerArgoWorkflowOptions = z.output<
  typeof buildRunnerArgoWorkflowOptionsSchema
> & {
  plan: WorkflowExecutionPlan;
};
export type ParsedBuildDynamicRunnerArgoWorkflowOptions = z.output<
  typeof buildDynamicRunnerArgoWorkflowOptionsSchema
>;
