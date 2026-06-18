import { Data } from "effect";
import { z } from "zod";

export const ID_RE = /^[a-z][a-z0-9-]*$/;

const RUNNER_TYPES = ["opencode", "command"] as const;
const NODE_KINDS = [
  "agent",
  "command",
  "builtin",
  "group",
  "parallel",
] as const;
export const HOOK_EVENTS = [
  "workflow.start",
  "workflow.success",
  "workflow.failure",
  "workflow.complete",
  "node.start",
  "node.success",
  "node.error",
  "node.finish",
  "gate.failure",
] as const;
const TOOL_NAMES = [
  "read",
  "list",
  "grep",
  "glob",
  "bash",
  "edit",
  "write",
  "task",
] as const;
const FILESYSTEM_MODES = ["read-only", "workspace-write"] as const;
const NETWORK_MODES = ["inherit", "disabled"] as const;
const OUTPUT_FORMATS = ["text", "json", "jsonl", "json_schema"] as const;
const GATE_KINDS = [
  "acceptance",
  "artifact",
  "builtin",
  "changed_files",
  "command",
  "json_schema",
  "verdict",
] as const;
const BUILTIN_GATES = [
  "duplication",
  "fallow",
  "lint",
  "semgrep",
  "test",
  "typecheck",
] as const;
const RETRY_REASONS = ["exit_nonzero", "gate_failure", "timeout"] as const;
const SCHEDULE_BASELINES = ["execute", "quick"] as const;
const SCHEDULE_STRATEGIES = ["planner"] as const;
const SCHEDULING_ROLES = ["coverage", "implementation"] as const;
const MCP_GATEWAY_BACKEND_LOCALITIES = [
  "repo-local",
  "repo-scoped-remote",
  "shared-remote",
] as const;
const MCP_GATEWAY_WORKSPACE_PATH_SOURCES = [
  "PIPELINE_TARGET_PATH",
  "cwd",
] as const;
export const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";
const DEFAULT_RUNNER_COMMAND_GIT_COMMITTER = {
  email: "git@oisin.ee",
  name: "oisin-bot",
} as const;

export type PipelineConfigErrorCode =
  | "PIPELINE_CONFIG_LEGACY_UNSUPPORTED"
  | "PIPELINE_CONFIG_PARSE_ERROR"
  | "PIPELINE_CONFIG_VALIDATION_ERROR";

export interface PipelineConfigIssue {
  message: string;
  path?: string;
}

export class PipelineConfigError extends Data.TaggedError(
  "PipelineConfigError"
)<{
  readonly code: PipelineConfigErrorCode;
  readonly message: string;
  readonly issues: PipelineConfigIssue[];
}> {
  constructor(
    code: PipelineConfigErrorCode,
    message: string,
    issues: PipelineConfigIssue[] = []
  ) {
    super({ code, message, issues });
  }
}

const strictRecord = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.record(z.string(), valueSchema);

const runnerCapabilitiesSchema = z
  .object({
    filesystem: z.array(z.enum(FILESYSTEM_MODES)).optional(),
    mcp_servers: z.boolean().optional(),
    native_subagents: z.boolean().optional(),
    network: z.array(z.enum(NETWORK_MODES)).optional(),
    output_formats: z.array(z.enum(OUTPUT_FORMATS)).optional(),
    rules: z.boolean().optional(),
    skills: z.boolean().optional(),
    tools: z.array(z.enum(TOOL_NAMES)).optional(),
  })
  .strict();

const runnerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    capabilities: runnerCapabilitiesSchema,
    command: z.string().optional(),
    host_models: z.record(z.string(), z.string().min(1)).optional(),
    model: z.string().optional(),
    type: z.enum(RUNNER_TYPES),
  })
  .strict();

const pathRefSchema = z
  .object({
    path: z.string().min(1),
    source_root: z.enum(["package", "project"]).default("project"),
  })
  .strict();

const mcpServerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    bearer_token_env_var: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    url: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "MCP server url must use http or https",
        }
      )
      .optional(),
  })
  .strict()
  .superRefine((server, ctx) => {
    const hasCommand = Boolean(server.command);
    const hasUrl = Boolean(server.url);
    if (hasCommand === hasUrl) {
      ctx.addIssue({
        code: "custom",
        message: "MCP server must declare exactly one of command or url",
        path: hasCommand ? ["url"] : ["command"],
      });
    }
    if (hasUrl && server.args) {
      ctx.addIssue({
        code: "custom",
        message: "args are only valid for command MCP servers",
        path: ["args"],
      });
    }
    if (hasUrl && server.env) {
      ctx.addIssue({
        code: "custom",
        message: "env is only valid for command MCP servers",
        path: ["env"],
      });
    }
    if (hasCommand && server.headers) {
      ctx.addIssue({
        code: "custom",
        message: "headers are only valid for url MCP servers",
        path: ["headers"],
      });
    }
    if (hasCommand && server.bearer_token_env_var) {
      ctx.addIssue({
        code: "custom",
        message: "bearer_token_env_var is only valid for url MCP servers",
        path: ["bearer_token_env_var"],
      });
    }
    if (
      hasUrl &&
      server.bearer_token_env_var &&
      Object.keys(server.headers ?? {}).some(
        (key) => key.toLowerCase() === "authorization"
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "headers.Authorization cannot be combined with bearer_token_env_var",
        path: ["bearer_token_env_var"],
      });
    }
  });

const mcpGatewayBackendSchema = z
  .object({
    locality: z.enum(MCP_GATEWAY_BACKEND_LOCALITIES),
    required: z.boolean().default(true),
    tool_prefixes: z.array(z.string().min(1)).min(1),
    workspace_path_source: z
      .enum(MCP_GATEWAY_WORKSPACE_PATH_SOURCES)
      .optional(),
  })
  .strict()
  .superRefine((backend, ctx) => {
    if (backend.locality === "repo-local") {
      if (!backend.workspace_path_source) {
        ctx.addIssue({
          code: "custom",
          message:
            "repo-local gateway backend must declare workspace_path_source as PIPELINE_TARGET_PATH or cwd",
          path: ["workspace_path_source"],
        });
      }
      return;
    }
    if (backend.workspace_path_source) {
      ctx.addIssue({
        code: "custom",
        message:
          "workspace_path_source is only valid for repo-local gateway backends",
        path: ["workspace_path_source"],
      });
    }
  });

const mcpGatewaySchema = z
  .object({
    backends: strictRecord(mcpGatewayBackendSchema).default({}),
    default_profile: z.string().min(1).optional(),
    // PIPE-83.11: where the singleton pipeline gateway is registered. "project"
    // (default) embeds it in each repo's .opencode/opencode.json; "global" stops
    // the per-project synthesis and inherits one global registration (written
    // once via `moka gateway configure-host --scope global`).
    host_scope: z.enum(["project", "global"]).default("project"),
    mode: z.enum(["hosted", "local"]),
    provider: z.literal("toolhive"),
    authorization_env: z
      .string()
      .min(1)
      .default("PIPELINE_MCP_GATEWAY_AUTHORIZATION"),
    url: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "MCP gateway url must use http or https",
        }
      )
      .optional(),
    url_env: z.string().min(1).default("PIPELINE_MCP_GATEWAY_URL"),
  })
  .strict();

const instructionsSchema = z
  .object({
    inline: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

const filesystemSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    mode: z.enum(FILESYSTEM_MODES),
  })
  .strict();

const networkSchema = z
  .object({
    mode: z.enum(NETWORK_MODES),
  })
  .strict();

const outputRepairSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_attempts: z.number().int().positive().optional(),
    runner: z.string().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    format: z.enum(OUTPUT_FORMATS),
    repair: outputRepairSchema.optional(),
    schema_path: z.string().min(1).optional(),
  })
  .strict();

const artifactSchema = z
  .object({
    path: z.string().min(1),
    required: z.boolean().optional(),
  })
  .strict();

const modelFallbacksSchema = z.array(z.string().min(1)).min(1);

const changedFilesPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    include_untracked: z.boolean().optional(),
    require_any: z.array(z.string()).optional(),
  })
  .strict();

const gateBaseSchema = z.object({
  id: z.string().optional(),
  required: z.boolean().optional(),
});

const jsonSourceGateSchema = gateBaseSchema.extend({
  path: z.string().min(1).optional(),
  target: z.enum(["artifact", "stdout"]).optional(),
});

const gateSchema = z.discriminatedUnion("kind", [
  jsonSourceGateSchema
    .extend({
      acceptance_key: z.string().optional(),
      kind: z.literal("acceptance"),
    })
    .strict(),
  gateBaseSchema
    .extend({
      kind: z.literal("artifact"),
      path: z.string().min(1),
    })
    .strict(),
  gateBaseSchema
    .extend({
      builtin: z.enum(BUILTIN_GATES),
      kind: z.literal("builtin"),
    })
    .strict(),
  gateBaseSchema
    .extend({
      changed_files: changedFilesPolicySchema,
      kind: z.literal("changed_files"),
    })
    .strict(),
  gateBaseSchema
    .extend({
      command: z.array(z.string()),
      expect_exit_code: z.number().int().optional(),
      kind: z.literal("command"),
      timeout_ms: z.number().int().positive().optional(),
    })
    .strict(),
  jsonSourceGateSchema
    .extend({
      kind: z.literal("json_schema"),
      schema_path: z.string().min(1),
    })
    .strict(),
  jsonSourceGateSchema
    .extend({
      equals: z.string().optional(),
      field: z.string().optional(),
      kind: z.literal("verdict"),
    })
    .strict(),
]);

const retriesSchema = z
  .object({
    backoff_ms: z.number().int().nonnegative().optional(),
    max_attempts: z.number().int().positive(),
    multiplier: z.number().positive().optional(),
    retry_on: z.array(z.enum(RETRY_REASONS)).optional(),
  })
  .strict();

const workflowExecutionSchema = z
  .object({
    fail_fast: z.boolean().optional(),
    max_parallel_nodes: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const profileSchema = z
  .object({
    description: z.string().optional(),
    filesystem: filesystemSchema.optional(),
    host_models: z.record(z.string(), z.string().min(1)).optional(),
    instructions: instructionsSchema,
    mcp_servers: z.array(z.string()).optional(),
    model: z.string().optional(),
    network: networkSchema.optional(),
    output: outputSchema.optional(),
    rules: z.array(z.string()).optional(),
    runner: z.string(),
    scheduling_roles: z.array(z.enum(SCHEDULING_ROLES)).optional(),
    skills: z.array(z.string()).optional(),
    timeout_ms: z.number().int().positive().optional(),
    tools: z.array(z.enum(TOOL_NAMES)).optional(),
  })
  .strict();

const orchestratorSchema = z
  .object({
    profile: z.string(),
  })
  .strict();

const hookEnvSchema = z
  .object({
    passthrough: z.array(z.string()).optional(),
    set: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const hookPermissionsSchema = z
  .object({
    filesystem: z.enum(FILESYSTEM_MODES).optional(),
    network: z.enum(NETWORK_MODES).optional(),
  })
  .strict();

const hookReturnsSchema = z
  .object({
    schema: z.string().min(1).optional(),
  })
  .strict();

const moduleHookFunctionSchema = z
  .object({
    kind: z.literal("module"),
    module: z.string().min(1),
    permissions: hookPermissionsSchema.optional(),
    returns: hookReturnsSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const commandHookProtocolSchema = z
  .object({
    input: z.literal("file"),
    result: z.literal("file"),
  })
  .strict();

const commandHookFunctionSchema = z
  .object({
    command: z.array(z.string()).min(1),
    env: hookEnvSchema.optional(),
    kind: z.literal("command"),
    output_limit_bytes: z.number().int().positive().optional(),
    protocol: commandHookProtocolSchema.default({
      input: "file",
      result: "file",
    }),
    returns: hookReturnsSchema.optional(),
    timeout_ms: z.number().int().positive().optional(),
    trusted: z.boolean().optional(),
  })
  .strict();

const hookFunctionSchema = z.discriminatedUnion("kind", [
  moduleHookFunctionSchema,
  commandHookFunctionSchema,
]);

const hookBindingWhereSchema = z
  .object({
    gate: z.string().optional(),
    node: z.string().optional(),
    workflow: z.string().optional(),
  })
  .strict();

const hookBindingResultSchema = z
  .object({
    pass_to: z.enum(["downstream"]).optional(),
    publish: z.boolean().optional(),
    save_as: z.string().min(1).optional(),
  })
  .strict();

const hookBindingSchema = z
  .object({
    failure: z.enum(["fail", "ignore"]).default("ignore"),
    function: z.string().min(1),
    id: z.string().min(1),
    result: hookBindingResultSchema.optional(),
    where: hookBindingWhereSchema.optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const hookPolicySchema = z
  .object({
    commands: z.enum(["allow", "trusted-only", "deny"]).optional(),
    modules: z.enum(["allow", "deny"]).optional(),
  })
  .strict();

const hooksConfigSchema = z
  .object({
    functions: strictRecord(hookFunctionSchema).default({}),
    on: strictRecord(z.array(hookBindingSchema)).default({}),
    policy: hookPolicySchema.optional(),
  })
  .strict();

const taskContextResolverSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

const nodeTaskContextSchema = z
  .object({
    acceptance_criteria: z
      .array(
        z
          .object({
            id: z.string().min(1),
            text: z.string().min(1),
          })
          .strict()
      )
      .optional(),
    description: z.string().optional(),
    id: z.string().min(1).optional(),
    title: z.string().optional(),
  })
  .strict();

const entrypointBaseSchema = z.object({
  description: z.string().optional(),
  task_context: taskContextResolverSchema.optional(),
});

const entrypointSchema = z.union([
  entrypointBaseSchema
    .extend({
      workflow: z.string(),
    })
    .strict(),
  entrypointBaseSchema
    .extend({
      schedule: z.string(),
    })
    .strict(),
]);

const schedulePolicySchema = z
  .object({
    description: z.string().optional(),
    baseline: z.enum(SCHEDULE_BASELINES),
    max_parallel_nodes: z.number().int().positive().optional(),
    node_catalog: z.string().min(1).optional(),
    planner_profile: z.string().optional(),
    strategy: z.enum(SCHEDULE_STRATEGIES).default("planner"),
  })
  .strict();

const schedulerCommandSchema = z
  .object({
    catalog: z.string().min(1),
    schedule: z.string().min(1),
  })
  .strict();

const schedulerNodeTemplateSchema = z
  .object({
    category: z.string().min(1),
    description: z.string().optional(),
    gates: z.array(gateSchema).optional(),
    models: modelFallbacksSchema,
    profile: z.string().min(1),
  })
  .strict();

const schedulerNodeCatalogSchema = z
  .object({
    nodes: strictRecord(schedulerNodeTemplateSchema).default({}),
    required_categories: z.array(z.string().min(1)).default([]),
  })
  .strict();

const schedulerConfigSchema = z
  .object({
    commands: strictRecord(schedulerCommandSchema).default({}),
    node_catalogs: strictRecord(schedulerNodeCatalogSchema).default({}),
  })
  .strict();

const workflowNodeBaseSchema = z.object({
  artifacts: z.array(artifactSchema).optional(),
  gates: z.array(gateSchema).optional(),
  id: z.string(),
  models: modelFallbacksSchema.optional(),
  needs: z.array(z.string()).optional(),
  retries: retriesSchema.optional(),
  task_context: nodeTaskContextSchema.optional(),
  timeout_ms: z.number().int().positive().optional(),
});

type WorkflowNodeBase = z.infer<typeof workflowNodeBaseSchema>;
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
  | CommandWorkflowNode
  | BuiltinWorkflowNode
  | GroupWorkflowNode
  | ParallelWorkflowNode;

const workflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    workflowNodeBaseSchema
      .extend({
        category: z.string().min(1).optional(),
        kind: z.literal("agent"),
        profile: z.string(),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        command: z.array(z.string()),
        kind: z.literal("command"),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        builtin: z.string(),
        kind: z.literal("builtin"),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        kind: z.literal("group"),
        nodes: z.array(z.string()).min(1),
      })
      .strict(),
    workflowNodeBaseSchema
      .extend({
        kind: z.literal("parallel"),
        nodes: z.array(workflowNodeSchema).min(1),
      })
      .strict(),
  ])
);

export const workflowSchema = z
  .object({
    description: z.string().optional(),
    execution: workflowExecutionSchema.optional(),
    nodes: z.array(workflowNodeSchema),
  })
  .strict();

const runnerCommandCommandSchema = z
  .object({
    args: z.array(z.string()).default([]),
    command: z.string().min(1),
    required: z.boolean().default(true),
  })
  .strict();

const runnerCommandEnvironmentSchema = z
  .object({
    setup: z.array(runnerCommandCommandSchema).default([]),
    smoke: z.array(runnerCommandCommandSchema).default([]),
  })
  .strict();

const runnerCommandGitCommitterSchema = z
  .object({
    email: z
      .string()
      .email()
      .default(DEFAULT_RUNNER_COMMAND_GIT_COMMITTER.email),
    name: z.string().min(1).default(DEFAULT_RUNNER_COMMAND_GIT_COMMITTER.name),
  })
  .strict();

const runnerCommandGitSchema = z
  .object({
    committer: runnerCommandGitCommitterSchema.default(
      DEFAULT_RUNNER_COMMAND_GIT_COMMITTER
    ),
  })
  .strict();

const runnerCommandConfigSchema = z
  .object({
    environment: runnerCommandEnvironmentSchema.default({
      setup: [],
      smoke: [],
    }),
    git: runnerCommandGitSchema.default({
      committer: DEFAULT_RUNNER_COMMAND_GIT_COMMITTER,
    }),
  })
  .strict();

export const runnersFileSchema = z
  .object({
    runners: strictRecord(runnerSchema).default({}),
    version: z.literal(1),
  })
  .strict();

export const profilesFileSchema = z
  .object({
    mcp_gateway: mcpGatewaySchema.optional(),
    mcp_servers: strictRecord(z.never()).default({}),
    profiles: strictRecord(profileSchema).default({}),
    rules: strictRecord(pathRefSchema).default({}),
    skills: strictRecord(pathRefSchema).default({}),
    version: z.literal(1),
  })
  .strict();

const fanOutWidthSchema = z
  .object({
    default: z.number().int().positive().default(4),
    by_category: strictRecord(z.number().int().positive()).default({}),
  })
  .strict();

const tokenBudgetSchema = z
  .object({
    default_context_window: z.number().int().positive().default(200_000),
    max_context_pct: z.number().positive().max(100).default(50),
    model_context_windows: strictRecord(z.number().int().positive()).default(
      {}
    ),
    fan_out_width: fanOutWidthSchema.default({ default: 4, by_category: {} }),
  })
  .strict();

const DEFAULT_TOKEN_BUDGET = {
  default_context_window: 200_000,
  max_context_pct: 50,
  model_context_windows: {},
  fan_out_width: { default: 4, by_category: {} },
} as const;

// PIPE-83.1: opt-in derivation of structured NodeHandoffs between nodes. Default
// OFF so behaviour (and the PIPE-57 goldens) is unchanged until PIPE-83.5
// consumes handoffs in renderAgentPrompt. `model` routes the cheap finalizer.
const contextHandoffSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().optional(),
  })
  .strict();

// PIPE-83.4: opt-in git-worktree isolation for parallel child nodes. Default OFF
// so parallel nodes keep running children in the shared worktree (and existing
// tests/goldens are unchanged) until best-of-N (PIPE-83.7) needs isolation.
const parallelWorktreesSchema = z
  .object({ enabled: z.boolean().default(false) })
  .strict();

// PIPE-83.10: opt-in durable crash-resume. When enabled, the scheduler journals
// each terminal node result to an append-only JSONL log under `dir` keyed by
// run id; a killed run resumes from the last passed node without re-running (or
// re-spending tokens on) finished work. Default OFF → pure in-memory behaviour.
const durabilitySchema = z
  .object({
    dir: z.string().min(1).default(".pipeline/journal"),
    enabled: z.boolean().default(false),
  })
  .strict();

// PIPE-83.7: opt-in best-of-N candidate generation. When enabled, a deterministic
// schedule pass expands each matching agent node (by category-in-id) into a
// kind:parallel of N candidate children. Default OFF / n=1 so schedules are
// unchanged until PIPE-83.9's selector picks among candidates.
// PIPE-83.2/83.5: opt-in repo-map code-context selection. When enabled,
// renderAgentPrompt prepends a tree-sitter + PageRank ranked code map (seeded by
// the node's task + handoff artifacts) within token_budget. Default OFF.
const repoMapSchema = z
  .object({
    enabled: z.boolean().default(false),
    token_budget: z.number().int().positive().default(2000),
  })
  .strict();

// Opt-in delivery configuration. When pull_request.enabled is true the
// schedule planner appends an open-pull-request builtin node as the final
// join in the root workflow, creating a preview PR after every successful run.
const deliverySchema = z
  .object({
    pull_request: z
      .object({
        enabled: z.boolean().default(false),
        label: z.string().min(1).default("preview"),
      })
      .strict()
      .optional(),
  })
  .strict();

export const pipelineFileSchema = z
  .object({
    default_workflow: z.string(),
    context_handoff: contextHandoffSchema.optional(),
    delivery: deliverySchema.optional(),
    durability: durabilitySchema.optional(),
    entrypoints: strictRecord(entrypointSchema).default({}),
    hooks: hooksConfigSchema.default({ functions: {}, on: {} }),
    orchestrator: orchestratorSchema.optional(),
    parallel_worktrees: parallelWorktreesSchema.optional(),
    repo_map: repoMapSchema.optional(),
    runner_command: runnerCommandConfigSchema.default({
      environment: { setup: [], smoke: [] },
      git: { committer: DEFAULT_RUNNER_COMMAND_GIT_COMMITTER },
    }),
    scheduler: schedulerConfigSchema.default({
      commands: {},
      node_catalogs: {},
    }),
    schedules: strictRecord(schedulePolicySchema).default({}),
    task_context: taskContextResolverSchema.optional(),
    token_budget: tokenBudgetSchema.default(DEFAULT_TOKEN_BUDGET),
    workflows: strictRecord(workflowSchema).default({}),
    version: z.literal(1),
  })
  .strict();

const configSchemaBase = z
  .object({
    default_workflow: z.string(),
    entrypoints: strictRecord(entrypointSchema).default({}),
    hooks: hooksConfigSchema.default({ functions: {}, on: {} }),
    mcp_gateway: mcpGatewaySchema.optional(),
    mcp_servers: strictRecord(mcpServerSchema).default({}),
    orchestrator: orchestratorSchema.optional(),
    profiles: strictRecord(profileSchema).default({}),
    runner_command: runnerCommandConfigSchema.default({
      environment: { setup: [], smoke: [] },
      git: { committer: DEFAULT_RUNNER_COMMAND_GIT_COMMITTER },
    }),
    rules: strictRecord(pathRefSchema).default({}),
    runners: strictRecord(runnerSchema).default({}),
    scheduler: schedulerConfigSchema.default({
      commands: {},
      node_catalogs: {},
    }),
    schedules: strictRecord(schedulePolicySchema).default({}),
    skills: strictRecord(pathRefSchema).default({}),
    task_context: taskContextResolverSchema.optional(),
    context_handoff: contextHandoffSchema.optional(),
    delivery: deliverySchema.optional(),
    durability: durabilitySchema.optional(),
    parallel_worktrees: parallelWorktreesSchema.optional(),
    repo_map: repoMapSchema.optional(),
    token_budget: tokenBudgetSchema.default(DEFAULT_TOKEN_BUDGET),
    version: z.literal(1),
    workflows: strictRecord(workflowSchema).default({}),
  })
  .strict();

export const configSchema = configSchemaBase.superRefine(
  validateConfigReferences
);

type ConfigSchemaInput = z.infer<typeof configSchemaBase>;
interface ConfigReferenceIssue {
  message: string;
  path: (number | string)[];
}
interface RegistryReferenceRule<TRecord> {
  field: string;
  message: (recordId: string, value: string) => string;
  read: (record: TRecord) => string | undefined;
  registry: Record<string, unknown>;
}

function validateConfigReferences(
  config: ConfigSchemaInput,
  ctx: z.RefinementCtx
): void {
  addConfigSchemaIssues(ctx, configReferenceIssues(config));
}

function configReferenceIssues(
  config: ConfigSchemaInput
): ConfigReferenceIssue[] {
  return [
    ...missingRegistryReferenceIssue({
      message: (_field, value) => `default workflow '${value}' is not declared`,
      path: ["default_workflow"],
      registry: config.workflows,
      value: config.default_workflow,
    }),
    ...registryReferenceIssues("entrypoints", config.entrypoints, [
      {
        field: "workflow",
        message: (entrypointId, value) =>
          `entrypoint '${entrypointId}' references missing workflow '${value}'`,
        read: (entrypoint) =>
          "workflow" in entrypoint ? entrypoint.workflow : undefined,
        registry: config.workflows,
      },
      {
        field: "schedule",
        message: (entrypointId, value) =>
          `entrypoint '${entrypointId}' references missing schedule '${value}'`,
        read: (entrypoint) =>
          "schedule" in entrypoint ? entrypoint.schedule : undefined,
        registry: config.schedules,
      },
    ]),
    ...registryReferenceIssues("schedules", config.schedules, [
      {
        field: "planner_profile",
        message: (scheduleId, value) =>
          `schedule '${scheduleId}' references missing planner profile '${value}'`,
        read: (schedule) => schedule.planner_profile,
        registry: config.profiles,
      },
      {
        field: "node_catalog",
        message: (scheduleId, value) =>
          `schedule '${scheduleId}' references missing scheduler node catalog '${value}'`,
        read: (schedule) => schedule.node_catalog,
        registry: config.scheduler.node_catalogs,
      },
    ]),
    ...registryReferenceIssues(
      "scheduler.commands",
      config.scheduler.commands,
      [
        {
          field: "catalog",
          message: (commandId, value) =>
            `scheduler command '${commandId}' references missing node catalog '${value}'`,
          read: (command) => command.catalog,
          registry: config.scheduler.node_catalogs,
        },
        {
          field: "schedule",
          message: (commandId, value) =>
            `scheduler command '${commandId}' references missing schedule '${value}'`,
          read: (command) => command.schedule,
          registry: config.schedules,
        },
      ]
    ),
    ...Object.entries(config.scheduler.node_catalogs).flatMap(
      ([catalogId, catalog]) =>
        registryReferenceIssues(
          `scheduler.node_catalogs.${catalogId}.nodes`,
          catalog.nodes,
          [
            {
              field: "profile",
              message: (nodeId, value) =>
                `scheduler node '${catalogId}.${nodeId}' references missing profile '${value}'`,
              read: (node) => node.profile,
              registry: config.profiles,
            },
          ]
        )
    ),
  ];
}

function registryReferenceIssues<TRecord>(
  registryPath: string,
  records: Record<string, TRecord>,
  rules: RegistryReferenceRule<TRecord>[]
): ConfigReferenceIssue[] {
  return Object.entries(records).flatMap(([recordId, record]) =>
    rules.flatMap((rule) =>
      missingRegistryReferenceIssue({
        message: (_field, value) => rule.message(recordId, value),
        path: [registryPath, recordId, rule.field],
        registry: rule.registry,
        value: rule.read(record),
      })
    )
  );
}

function missingRegistryReferenceIssue({
  message,
  path,
  registry,
  value,
}: {
  message: (field: string, value: string) => string;
  path: (number | string)[];
  registry: Record<string, unknown>;
  value: string | undefined;
}): ConfigReferenceIssue[] {
  return value && !Object.hasOwn(registry, value)
    ? [{ message: message(String(path.at(-1)), value), path }]
    : [];
}

function addConfigSchemaIssues(
  ctx: z.RefinementCtx,
  issues: ConfigReferenceIssue[]
): void {
  for (const issue of issues) {
    addConfigSchemaIssue(ctx, issue.path, issue.message);
  }
}

function addConfigSchemaIssue(
  ctx: z.RefinementCtx,
  path: (number | string)[],
  message: string
): void {
  ctx.addIssue({ code: "custom", path, message });
}

export type PipelineConfig = z.infer<typeof configSchema>;
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

export function validationError(
  issues: PipelineConfigIssue[]
): PipelineConfigError {
  return new PipelineConfigError(
    "PIPELINE_CONFIG_VALIDATION_ERROR",
    [
      "Invalid pipeline config:",
      ...issues.map((issue) =>
        issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`
      ),
    ].join("\n"),
    issues
  );
}

export function configIssuesFromZodError(
  error: z.ZodError
): PipelineConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
