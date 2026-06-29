import type {
  ArgoWorkflowEnvVar,
  ArgoWorkflowResourceRequirements,
  ArgoWorkflowRetryStrategy,
  ParsedBuildRunnerArgoWorkflowOptions,
} from "./model";

export const RUNNER_WORKFLOW_IMAGE = "ghcr.io/oisin-ee/pipeline-runner:latest";
export const RUNNER_WORKFLOW_SERVICE_ACCOUNT = "pipeline-runner";
export const RUNNER_WORKFLOW_ENTRYPOINT = "pipeline";
export const RUNNER_WORKFLOW_START_TASK = "workflow-start";
export const RUNNER_WORKFLOW_PAYLOAD_PATH = "/etc/pipeline/payload.json";
export const RUNNER_WORKFLOW_SCHEDULE_PATH = "/etc/pipeline/schedule.yaml";
export const RUNNER_GIT_CREDENTIALS_PATH = "/etc/pipeline/git-credentials";

const RUNNER_RETRY_STRATEGY: ArgoWorkflowRetryStrategy = {
  expression:
    "lastRetry.status == 'Error' || (lastRetry.exitCode != '0' && lastRetry.exitCode != '1')",
  limit: "3",
  retryPolicy: "Always",
};

const RUNNER_OPENCODE_ENV: ArgoWorkflowEnvVar[] = [
  { name: "CODEX_AUTH_PER_PROJECT_ACCOUNTS", value: "0" },
  { name: "PIPELINE_AGENT_TIMEOUT_MS", value: "600000" },
  { name: "PIPELINE_AGENT_IDLE_TIMEOUT_MS", value: "180000" },
  { name: "PIPELINE_DISABLED_MODELS", value: "opencode-go/qwen3.7-max" },
];

const DEFAULT_RUNNER_RESOURCES: ArgoWorkflowResourceRequirements = {
  limits: { cpu: "4", memory: "12Gi" },
  requests: { cpu: "1", memory: "5Gi" },
};

const DEFAULT_RUNNER_DEADLINE_SECONDS = 5400;

export function runnerContainerEnv(
  options: ParsedBuildRunnerArgoWorkflowOptions
): ArgoWorkflowEnvVar[] {
  return [
    ...RUNNER_OPENCODE_ENV,
    { name: "BROKER_URL", value: options.brokerAuth.url },
    {
      name: "PIPELINE_BROKER_SECRET_NAME",
      value: options.brokerAuth.secretName,
    },
    {
      name: "PIPELINE_BROKER_SECRET_KEY",
      value: options.brokerAuth.secretKey,
    },
    {
      name: "BROKER_API_KEY",
      valueFrom: {
        secretKeyRef: {
          key: options.brokerAuth.secretKey,
          name: options.brokerAuth.secretName,
        },
      },
    },
    // PIPE-94.3: expose db.url to in-cluster runner pods via secretKeyRef so
    // loadMokaDbUrl() resolves from MOKA_DB_URL without a config-file mount.
    // Absent when dbAuth is not configured — cluster without the secret still
    // renders a valid workflow.
    ...(options.dbAuth === undefined
      ? []
      : [
          {
            name: "MOKA_DB_URL",
            valueFrom: {
              secretKeyRef: {
                key: options.dbAuth.secretKey,
                name: options.dbAuth.secretName,
              },
            },
          },
        ]),
    // Expose the pipeline-gateway basic-auth header to in-cluster runner pods via
    // secretKeyRef so dotfiles' opencode pipeline-gateway MCP entry resolves
    // PIPELINE_MCP_GATEWAY_AUTHORIZATION without any plaintext in the manifest.
    // Absent when mcpGatewayAuth is not configured — cluster without the secret
    // still renders a valid workflow.
    ...(options.mcpGatewayAuth === undefined
      ? []
      : [
          {
            name: "PIPELINE_MCP_GATEWAY_AUTHORIZATION",
            valueFrom: {
              secretKeyRef: {
                key: options.mcpGatewayAuth.secretKey,
                name: options.mcpGatewayAuth.secretName,
              },
            },
          },
        ]),
  ];
}

export function runnerRetryStrategy(): ArgoWorkflowRetryStrategy {
  return { ...RUNNER_RETRY_STRATEGY };
}

export function runnerTemplateResources(
  options: ParsedBuildRunnerArgoWorkflowOptions
): ArgoWorkflowResourceRequirements {
  return options.resources ?? DEFAULT_RUNNER_RESOURCES;
}

export function runnerTemplateDeadlineSeconds(): number {
  return DEFAULT_RUNNER_DEADLINE_SECONDS;
}
