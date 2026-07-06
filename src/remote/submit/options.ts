import * as Schema from "effect/Schema";

import { brokerAuthOptionSchema } from "../../credentials/broker";
import { requiredString } from "../../schema-boundary";
import {
  argoWorkflowActiveDeadlineSecondsSchema,
  argoWorkflowPodGcSchema,
  argoWorkflowTtlStrategySchema,
  dbAuthOptionSchema,
  mcpGatewayAuthOptionSchema,
} from "../argo/model";

export const runnerPodSubmitOptionShape = {
  activeDeadlineSeconds: Schema.optional(argoWorkflowActiveDeadlineSecondsSchema),
  brokerAuth: brokerAuthOptionSchema,
  dbAuth: Schema.optional(dbAuthOptionSchema),
  eventAuthSecretKey: Schema.optional(requiredString),
  eventAuthSecretName: Schema.optional(requiredString),
  generateName: Schema.optional(requiredString),
  gitCredentialsSecretName: Schema.optional(requiredString),
  githubAuthSecretName: Schema.optional(requiredString),
  image: Schema.optional(requiredString),
  imagePullSecretName: Schema.optional(requiredString),
  kubeContext: Schema.optional(requiredString),
  kubeconfigPath: Schema.optional(requiredString),
  mcpGatewayAuth: Schema.optional(mcpGatewayAuthOptionSchema),
  name: Schema.optional(requiredString),
  npmRegistryAuthSecretName: Schema.optional(requiredString),
  podGC: Schema.optional(argoWorkflowPodGcSchema),
  serviceAccountName: Schema.optional(requiredString),
  ttlStrategy: Schema.optional(argoWorkflowTtlStrategySchema),
};
