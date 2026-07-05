import { z } from "zod";

import { brokerAuthOptionSchema } from "../../credentials/broker";
import {
  argoWorkflowActiveDeadlineSecondsSchema,
  argoWorkflowPodGcSchema,
  argoWorkflowTtlStrategySchema,
  dbAuthOptionSchema,
  mcpGatewayAuthOptionSchema,
} from "../argo/model";

export const runnerPodSubmitOptionShape = {
  activeDeadlineSeconds: argoWorkflowActiveDeadlineSecondsSchema.optional(),
  brokerAuth: brokerAuthOptionSchema,
  dbAuth: dbAuthOptionSchema.optional(),
  eventAuthSecretKey: z.string().min(1).optional(),
  eventAuthSecretName: z.string().min(1).optional(),
  generateName: z.string().min(1).optional(),
  gitCredentialsSecretName: z.string().min(1).optional(),
  githubAuthSecretName: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  imagePullSecretName: z.string().min(1).optional(),
  kubeContext: z.string().min(1).optional(),
  kubeconfigPath: z.string().min(1).optional(),
  mcpGatewayAuth: mcpGatewayAuthOptionSchema.optional(),
  name: z.string().min(1).optional(),
  npmRegistryAuthSecretName: z.string().min(1).optional(),
  podGC: argoWorkflowPodGcSchema.optional(),
  serviceAccountName: z.string().min(1).optional(),
  ttlStrategy: argoWorkflowTtlStrategySchema.optional(),
};
