import * as Schema from "effect/Schema";

import {
  mutableArray,
  nonEmptyMutableArray,
  nonNegativeInteger,
  positiveInteger,
  positiveNumber,
  requiredString,
  stringRecord,
  unknownRecord,
  withDefault,
  struct,
} from "../schema-boundary";
import type { EffectSchemaIssue } from "../schema-boundary";
import {
  BUILTIN_GATES,
  DEFAULT_RUNNER_COMMAND_GIT_COMMITTER,
  FILESYSTEM_MODES,
  NETWORK_MODES,
  OUTPUT_FORMATS,
  REASONING_EFFORTS,
  RETRY_REASONS,
  RUNNER_TYPES,
  SCHEDULE_BASELINES,
  SCHEDULE_STRATEGIES,
  SCHEDULING_ROLES,
  TOOL_NAMES,
} from "./schema/catalog";
import type {
  GATE_KINDS,
  HOOK_EVENTS,
  MCP_GATEWAY_BACKEND_LOCALITIES,
  MCP_GATEWAY_WORKSPACE_PATH_SOURCES,
  NODE_KINDS,
} from "./schema/catalog";
import { mcpGatewaySchema, mcpServerSchema } from "./schema/mcp";

const reasoningEffort = Schema.Literals(REASONING_EFFORTS);

export type PipelineConfigErrorCode =
  | "PIPELINE_CONFIG_LEGACY_UNSUPPORTED"
  | "PIPELINE_CONFIG_PARSE_ERROR"
  | "PIPELINE_CONFIG_VALIDATION_ERROR";

export interface PipelineConfigIssue {
  message: string;
  path?: string;
}

const pipelineConfigErrorCode = Schema.Literals([
  "PIPELINE_CONFIG_LEGACY_UNSUPPORTED",
  "PIPELINE_CONFIG_PARSE_ERROR",
  "PIPELINE_CONFIG_VALIDATION_ERROR",
]);

const pipelineConfigIssue = struct({
  message: Schema.String,
  path: Schema.optional(Schema.String),
});

export class PipelineConfigError extends Schema.TaggedErrorClass<PipelineConfigError>()(
  "PipelineConfigError",
  {
    code: pipelineConfigErrorCode,
    issues: mutableArray(pipelineConfigIssue),
    message: Schema.String,
  }
) {
  constructor(
    code: PipelineConfigErrorCode,
    message: string,
    issues: PipelineConfigIssue[] = []
  ) {
    super({ code, issues, message });
  }
}

const strictRecord = <S extends Schema.Constraint>(valueSchema: S) =>
  Schema.Record(Schema.String, valueSchema);

const optionalStringArray = Schema.optional(mutableArray(Schema.String));

const runnerCapabilitiesSchema = struct({
  filesystem: Schema.optional(mutableArray(Schema.Literals(FILESYSTEM_MODES))),
  mcp_servers: Schema.optional(Schema.Boolean),
  native_subagents: Schema.optional(Schema.Boolean),
  network: Schema.optional(mutableArray(Schema.Literals(NETWORK_MODES))),
  output_formats: Schema.optional(
    mutableArray(Schema.Literals(OUTPUT_FORMATS))
  ),
  rules: Schema.optional(Schema.Boolean),
  skills: Schema.optional(Schema.Boolean),
  tools: Schema.optional(mutableArray(Schema.Literals(TOOL_NAMES))),
});

const runnerSchema = struct({
  args: optionalStringArray,
  capabilities: runnerCapabilitiesSchema,
  command: Schema.optional(Schema.String),
  host_models: Schema.optional(stringRecord),
  model: Schema.optional(Schema.String),
  reasoning_effort: Schema.optional(reasoningEffort),
  type: Schema.Literals(RUNNER_TYPES),
});

const pathRefSchema = struct({
  path: requiredString,
  source_root: withDefault(Schema.Literals(["package", "project"]), "project"),
});

const instructionsSchema = struct({
  inline: Schema.optional(requiredString),
  path: Schema.optional(requiredString),
});

const filesystemSchema = struct({
  allow: optionalStringArray,
  deny: optionalStringArray,
  mode: Schema.Literals(FILESYSTEM_MODES),
  protected: optionalStringArray,
});

const networkSchema = struct({
  mode: Schema.Literals(NETWORK_MODES),
});

const outputRepairSchema = struct({
  enabled: Schema.optional(Schema.Boolean),
  max_attempts: Schema.optional(positiveInteger),
  runner: Schema.optional(Schema.String),
});

const outputSchema = struct({
  format: Schema.Literals(OUTPUT_FORMATS),
  repair: Schema.optional(outputRepairSchema),
  schema_path: Schema.optional(requiredString),
});

const artifactSchema = struct({
  path: requiredString,
  required: Schema.optional(Schema.Boolean),
});

const modelFallbacksSchema = nonEmptyMutableArray(requiredString);

const changedFilesPolicySchema = struct({
  allow: optionalStringArray,
  deny: optionalStringArray,
  include_untracked: Schema.optional(Schema.Boolean),
  require_any: optionalStringArray,
});

const gateBaseFields = {
  id: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
};

const jsonSourceGateFields = {
  ...gateBaseFields,
  path: Schema.optional(requiredString),
  target: Schema.optional(Schema.Literals(["artifact", "stdout"])),
};

const gate = Schema.Union([
  struct({
    ...jsonSourceGateFields,
    acceptance_key: Schema.optional(Schema.String),
    kind: Schema.Literal("acceptance"),
  }),
  struct({
    ...gateBaseFields,
    kind: Schema.Literal("artifact"),
    path: requiredString,
  }),
  struct({
    ...gateBaseFields,
    builtin: Schema.Literals(BUILTIN_GATES),
    kind: Schema.Literal("builtin"),
  }),
  struct({
    ...gateBaseFields,
    changed_files: changedFilesPolicySchema,
    kind: Schema.Literal("changed_files"),
  }),
  struct({
    ...gateBaseFields,
    command: mutableArray(Schema.String),
    expect_exit_code: Schema.optional(Schema.Number.check(Schema.isInt())),
    kind: Schema.Literal("command"),
    timeout_ms: Schema.optional(positiveInteger),
  }),
  struct({
    ...jsonSourceGateFields,
    kind: Schema.Literal("json_schema"),
    schema_path: requiredString,
  }),
  struct({
    ...jsonSourceGateFields,
    equals: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
    kind: Schema.Literal("verdict"),
  }),
]);

const retriesSchema = struct({
  backoff_ms: Schema.optional(nonNegativeInteger),
  max_attempts: positiveInteger,
  multiplier: Schema.optional(positiveNumber),
  retry_on: Schema.optional(mutableArray(Schema.Literals(RETRY_REASONS))),
});

const workflowExecutionSchema = struct({
  fail_fast: Schema.optional(Schema.Boolean),
  max_parallel_nodes: Schema.optional(positiveInteger),
  timeout_ms: Schema.optional(positiveInteger),
});

const profileSchema = struct({
  description: Schema.optional(Schema.String),
  filesystem: Schema.optional(filesystemSchema),
  host_models: Schema.optional(stringRecord),
  instructions: instructionsSchema,
  mcp_servers: optionalStringArray,
  model: Schema.optional(Schema.String),
  network: Schema.optional(networkSchema),
  output: Schema.optional(outputSchema),
  reasoning_effort: Schema.optional(reasoningEffort),
  rules: optionalStringArray,
  runner: Schema.String,
  scheduling_roles: Schema.optional(
    mutableArray(Schema.Literals(SCHEDULING_ROLES))
  ),
  skills: optionalStringArray,
  timeout_ms: Schema.optional(positiveInteger),
  tools: Schema.optional(mutableArray(Schema.Literals(TOOL_NAMES))),
});

const orchestratorSchema = struct({
  profile: Schema.String,
});

const hookEnvSchema = struct({
  passthrough: optionalStringArray,
  set: Schema.optional(stringRecord),
});

const hookPermissionsSchema = struct({
  filesystem: Schema.optional(Schema.Literals(FILESYSTEM_MODES)),
  network: Schema.optional(Schema.Literals(NETWORK_MODES)),
});

const hookReturnsSchema = struct({
  schema: Schema.optional(requiredString),
});

const moduleHookFunctionSchema = struct({
  kind: Schema.Literal("module"),
  module: requiredString,
  permissions: Schema.optional(hookPermissionsSchema),
  returns: Schema.optional(hookReturnsSchema),
  timeout_ms: Schema.optional(positiveInteger),
});

const commandHookProtocolSchema = struct({
  input: Schema.Literal("file"),
  result: Schema.Literal("file"),
});

const commandHookFunctionSchema = struct({
  command: nonEmptyMutableArray(Schema.String),
  env: Schema.optional(hookEnvSchema),
  kind: Schema.Literal("command"),
  output_limit_bytes: Schema.optional(positiveInteger),
  protocol: withDefault(commandHookProtocolSchema, {
    input: "file",
    result: "file",
  }),
  returns: Schema.optional(hookReturnsSchema),
  timeout_ms: Schema.optional(positiveInteger),
  trusted: Schema.optional(Schema.Boolean),
});

const hookFunction = Schema.Union([
  moduleHookFunctionSchema,
  commandHookFunctionSchema,
]);

const hookBindingWhereSchema = struct({
  gate: Schema.optional(Schema.String),
  node: Schema.optional(Schema.String),
  workflow: Schema.optional(Schema.String),
});

const hookBindingResultSchema = struct({
  pass_to: Schema.optional(Schema.Literal("downstream")),
  publish: Schema.optional(Schema.Boolean),
  save_as: Schema.optional(requiredString),
});

const hookBindingSchema = struct({
  failure: withDefault(Schema.Literals(["fail", "ignore"]), "ignore"),
  function: requiredString,
  id: requiredString,
  result: Schema.optional(hookBindingResultSchema),
  where: Schema.optional(hookBindingWhereSchema),
  with: Schema.optional(unknownRecord),
});

const hookPolicySchema = struct({
  commands: Schema.optional(Schema.Literals(["allow", "trusted-only", "deny"])),
  modules: Schema.optional(Schema.Literals(["allow", "deny"])),
});

const hooksConfigSchema = struct({
  functions: withDefault(strictRecord(hookFunction), {}),
  on: withDefault(strictRecord(mutableArray(hookBindingSchema)), {}),
  policy: Schema.optional(hookPolicySchema),
});

const taskContextResolver = Schema.StructWithRest(
  struct({
    type: requiredString,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

const nodeTaskContextSchema = struct({
  acceptance_criteria: Schema.optional(
    mutableArray(
      struct({
        id: requiredString,
        text: requiredString,
      })
    )
  ),
  description: Schema.optional(Schema.String),
  id: Schema.optional(requiredString),
  title: Schema.optional(Schema.String),
});

const entrypointBaseFields = {
  description: Schema.optional(Schema.String),
  task_context: Schema.optional(taskContextResolver),
};

const entrypoint = Schema.Union([
  struct({
    ...entrypointBaseFields,
    workflow: Schema.String,
  }),
  struct({
    ...entrypointBaseFields,
    schedule: Schema.String,
  }),
]);

const schedulePolicySchema = struct({
  baseline: Schema.Literals(SCHEDULE_BASELINES),
  description: Schema.optional(Schema.String),
  max_parallel_nodes: Schema.optional(positiveInteger),
  node_catalog: Schema.optional(requiredString),
  planner_profile: Schema.optional(Schema.String),
  strategy: withDefault(Schema.Literals(SCHEDULE_STRATEGIES), "planner"),
});

const schedulerCommandSchema = struct({
  catalog: requiredString,
  schedule: requiredString,
});

const schedulerNodeTemplateSchema = struct({
  category: requiredString,
  description: Schema.optional(Schema.String),
  gates: Schema.optional(mutableArray(gate)),
  models: modelFallbacksSchema,
  profile: requiredString,
  reasoning_effort: Schema.optional(reasoningEffort),
});

const schedulerNodeCatalogSchema = struct({
  nodes: withDefault(strictRecord(schedulerNodeTemplateSchema), {}),
  required_categories: withDefault(mutableArray(requiredString), []),
});

const schedulerConfigSchema = struct({
  commands: withDefault(strictRecord(schedulerCommandSchema), {}),
  node_catalogs: withDefault(strictRecord(schedulerNodeCatalogSchema), {}),
});

const workflowNodeBaseFields = {
  artifacts: Schema.optional(mutableArray(artifactSchema)),
  gates: Schema.optional(mutableArray(gate)),
  id: Schema.String,
  models: Schema.optional(modelFallbacksSchema),
  needs: optionalStringArray,
  reasoning_effort: Schema.optional(reasoningEffort),
  retries: Schema.optional(retriesSchema),
  task_context: Schema.optional(nodeTaskContextSchema),
  timeout_ms: Schema.optional(positiveInteger),
};
const workflowNodeBaseSchema = struct(workflowNodeBaseFields);

type WorkflowNodeBase = typeof workflowNodeBaseSchema.Type;
type AgentWorkflowNode = WorkflowNodeBase & {
  category?: string;
  kind: "agent";
  profile: string;
};
type CommandWorkflowNode = WorkflowNodeBase & {
  command: string[];
  kind: "command";
};
type BuiltinWorkflowNode = WorkflowNodeBase & {
  builtin: string;
  kind: "builtin";
};
type GroupWorkflowNode = WorkflowNodeBase & {
  kind: "group";
  nodes: string[];
};
type ParallelWorkflowNode = WorkflowNodeBase & {
  kind: "parallel";
  nodes: WorkflowNode[];
};
type WorkflowNode =
  | AgentWorkflowNode
  | BuiltinWorkflowNode
  | CommandWorkflowNode
  | GroupWorkflowNode
  | ParallelWorkflowNode;

const workflowNode: Schema.Codec<WorkflowNode> = Schema.suspend(() =>
  Schema.Union([
    struct({
      ...workflowNodeBaseFields,
      category: Schema.optional(requiredString),
      kind: Schema.Literal("agent"),
      profile: Schema.String,
    }),
    struct({
      ...workflowNodeBaseFields,
      command: mutableArray(Schema.String),
      kind: Schema.Literal("command"),
    }),
    struct({
      ...workflowNodeBaseFields,
      builtin: Schema.String,
      kind: Schema.Literal("builtin"),
    }),
    struct({
      ...workflowNodeBaseFields,
      kind: Schema.Literal("group"),
      nodes: nonEmptyMutableArray(Schema.String),
    }),
    struct({
      ...workflowNodeBaseFields,
      kind: Schema.Literal("parallel"),
      nodes: nonEmptyMutableArray(workflowNode),
    }),
  ])
);

export const workflowSchema = struct({
  description: Schema.optional(Schema.String),
  execution: Schema.optional(workflowExecutionSchema),
  nodes: mutableArray(workflowNode),
});

const runnerCommandCommandSchema = struct({
  args: withDefault(mutableArray(Schema.String), []),
  command: requiredString,
  required: withDefault(Schema.Boolean, true),
});

const runnerCommandEnvironmentSchema = struct({
  setup: withDefault(mutableArray(runnerCommandCommandSchema), []),
  smoke: withDefault(mutableArray(runnerCommandCommandSchema), []),
});

const runnerCommandGitCommitterSchema = struct({
  email: withDefault(
    requiredString,
    DEFAULT_RUNNER_COMMAND_GIT_COMMITTER.email
  ),
  name: withDefault(requiredString, DEFAULT_RUNNER_COMMAND_GIT_COMMITTER.name),
});

const runnerCommandGitSchema = struct({
  committer: withDefault(
    runnerCommandGitCommitterSchema,
    DEFAULT_RUNNER_COMMAND_GIT_COMMITTER
  ),
});

const runnerCommandConfigSchema = struct({
  environment: withDefault(runnerCommandEnvironmentSchema, {
    setup: [],
    smoke: [],
  }),
  git: withDefault(runnerCommandGitSchema, {
    committer: DEFAULT_RUNNER_COMMAND_GIT_COMMITTER,
  }),
});

export const runnersFileSchema = struct({
  runners: withDefault(strictRecord(runnerSchema), {}),
  version: Schema.Literal(1),
});

export const profilesFileSchema = struct({
  mcp_gateway: Schema.optional(mcpGatewaySchema),
  mcp_servers: withDefault(strictRecord(Schema.Never), {}),
  profiles: withDefault(strictRecord(profileSchema), {}),
  rules: withDefault(strictRecord(pathRefSchema), {}),
  skills: withDefault(strictRecord(pathRefSchema), {}),
  version: Schema.Literal(1),
});

const fanOutWidthSchema = struct({
  by_category: withDefault(strictRecord(positiveInteger), {}),
  default: withDefault(positiveInteger, 4),
});

const tokenBudgetSchema = struct({
  default_context_window: withDefault(positiveInteger, 200_000),
  fan_out_width: withDefault(fanOutWidthSchema, {
    by_category: {},
    default: 4,
  }),
  max_context_pct: withDefault(
    positiveNumber.check(Schema.isLessThanOrEqualTo(100)),
    50
  ),
  model_context_windows: withDefault(strictRecord(positiveInteger), {}),
});

const contextHandoffSchema = struct({
  enabled: withDefault(Schema.Boolean, false),
  model: Schema.optional(Schema.String),
});

const parallelWorktreesSchema = struct({
  enabled: withDefault(Schema.Boolean, false),
});

const repoMapSchema = struct({
  enabled: withDefault(Schema.Boolean, false),
  token_budget: withDefault(positiveInteger, 2000),
});

const deliverySchema = struct({
  pull_request: Schema.optional(
    struct({
      enabled: withDefault(Schema.Boolean, false),
      head_branch: Schema.optional(requiredString),
      label: withDefault(requiredString, "preview"),
      mode: withDefault(
        Schema.Literals(["create-new-pr", "update-existing-pr"]),
        "create-new-pr"
      ),
    })
  ),
});

const pipelineConfigCoreShape = {
  context_handoff: Schema.optional(contextHandoffSchema),
  default_workflow: Schema.String,
  delivery: Schema.optional(deliverySchema),
  entrypoints: withDefault(strictRecord(entrypoint), {}),
  hooks: withDefault(hooksConfigSchema, { functions: {}, on: {} }),
  orchestrator: Schema.optional(orchestratorSchema),
  parallel_worktrees: Schema.optional(parallelWorktreesSchema),
  repo_map: Schema.optional(repoMapSchema),
  runner_command: withDefault(runnerCommandConfigSchema, {
    environment: { setup: [], smoke: [] },
    git: { committer: DEFAULT_RUNNER_COMMAND_GIT_COMMITTER },
  }),
  scheduler: withDefault(schedulerConfigSchema, {
    commands: {},
    node_catalogs: {},
  }),
  schedules: withDefault(strictRecord(schedulePolicySchema), {}),
  task_context: Schema.optional(taskContextResolver),
  token_budget: withDefault(tokenBudgetSchema, {
    default_context_window: 200_000,
    fan_out_width: { by_category: {}, default: 4 },
    max_context_pct: 50,
    model_context_windows: {},
  }),
  version: Schema.Literal(1),
  workflows: withDefault(strictRecord(workflowSchema), {}),
};

export const pipelineFileSchema = struct({
  ...pipelineConfigCoreShape,
});

export const configSchema = struct({
  ...pipelineConfigCoreShape,
  mcp_gateway: Schema.optional(mcpGatewaySchema),
  mcp_servers: withDefault(strictRecord(mcpServerSchema), {}),
  profiles: withDefault(strictRecord(profileSchema), {}),
  rules: withDefault(strictRecord(pathRefSchema), {}),
  runners: withDefault(strictRecord(runnerSchema), {}),
  skills: withDefault(strictRecord(pathRefSchema), {}),
});

export type PipelineConfig = typeof configSchema.Type;
export type RunnerType = (typeof RUNNER_TYPES)[number];
export type WorkflowNodeKind = (typeof NODE_KINDS)[number];
export type HookEvent = (typeof HOOK_EVENTS)[number];
export type GateKind = (typeof GATE_KINDS)[number];
export type ScheduleBaseline = (typeof SCHEDULE_BASELINES)[number];
export type SchedulingRole = (typeof SCHEDULING_ROLES)[number];
export type McpGatewayBackendLocality =
  (typeof MCP_GATEWAY_BACKEND_LOCALITIES)[number];
export type McpGatewayWorkspacePathSource =
  (typeof MCP_GATEWAY_WORKSPACE_PATH_SOURCES)[number];
export type ConfigGateSpec = NonNullable<
  PipelineConfig["workflows"][string]["nodes"][number]["gates"]
>[number];

export interface PipelineConfigParts {
  pipeline: string;
  profiles: string;
  runners: string;
}

export interface PipelineConfigValidationOptions {
  allowMissingLintFileReferences?: boolean;
}

export const validationError = (
  issues: PipelineConfigIssue[]
): PipelineConfigError =>
  new PipelineConfigError(
    "PIPELINE_CONFIG_VALIDATION_ERROR",
    [
      "Invalid pipeline config:",
      ...issues.map((issue) =>
        issue.path === undefined || issue.path === ""
          ? `- ${issue.message}`
          : `- ${issue.path}: ${issue.message}`
      ),
    ].join("\n"),
    issues
  );

export const configIssuesFromSchemaIssues = (
  issues: readonly EffectSchemaIssue[]
): PipelineConfigIssue[] =>
  issues.map((issue) => ({
    message: issue.message,
    path: issue.path.map(String).join("."),
  }));
