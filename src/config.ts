import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { resolveFileReference } from "./path-refs.js";

export const PIPELINE_CONFIG_PATH = ".pipeline/pipeline.yaml";
export const RUNNERS_CONFIG_PATH = ".pipeline/runners.yaml";
export const PROFILES_CONFIG_PATH = ".pipeline/profiles.yaml";
const LEGACY_CONFIG_PATH = ".pipeline/config.toml";

const ID_RE = /^[a-z][a-z0-9-]*$/;

const RUNNER_TYPES = ["codex", "opencode", "command"] as const;
const NODE_KINDS = [
  "agent",
  "command",
  "builtin",
  "group",
  "parallel",
  "workflow",
] as const;
const HOOK_EVENTS = [
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
const BUILTIN_GATES = ["duplication", "semgrep", "test", "typecheck"] as const;
const RETRY_REASONS = ["exit_nonzero", "gate_failure", "timeout"] as const;
const SCHEDULE_BASELINES = ["epic", "pipe"] as const;
const SCHEDULING_ROLES = ["coverage", "implementation"] as const;
const PIPELINE_GATEWAY_SERVER_ID = "pipeline-gateway";

export type PipelineConfigErrorCode =
  | "PIPELINE_CONFIG_LEGACY_UNSUPPORTED"
  | "PIPELINE_CONFIG_MISSING"
  | "PIPELINE_CONFIG_PARSE_ERROR"
  | "PIPELINE_CONFIG_VALIDATION_ERROR";

export interface PipelineConfigIssue {
  message: string;
  path?: string;
}

export class PipelineConfigError extends Error {
  code: PipelineConfigErrorCode;
  issues: PipelineConfigIssue[];

  constructor(
    code: PipelineConfigErrorCode,
    message: string,
    issues: PipelineConfigIssue[] = []
  ) {
    super(message);
    this.name = "PipelineConfigError";
    this.code = code;
    this.issues = issues;
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

const mcpGatewaySchema = z
  .object({
    default_profile: z.string().min(1).optional(),
    mode: z.enum(["hosted", "local"]),
    provider: z.literal("toolhive"),
    token_env: z.string().min(1).default("MEMORY_MCP_BASIC_AUTH"),
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
    planner_profile: z.string().optional(),
  })
  .strict();

const workflowNodeBaseSchema = z.object({
  artifacts: z.array(artifactSchema).optional(),
  gates: z.array(gateSchema).optional(),
  id: z.string(),
  needs: z.array(z.string()).optional(),
  retries: retriesSchema.optional(),
  task_context: nodeTaskContextSchema.optional(),
  timeout_ms: z.number().int().positive().optional(),
});

type WorkflowNodeBase = z.infer<typeof workflowNodeBaseSchema>;
type AgentWorkflowNode = WorkflowNodeBase & {
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
type ChildWorkflowNode = WorkflowNodeBase & {
  kind: "workflow";
  workflow: string;
  worktree_root?: string;
};
type WorkflowNode =
  | AgentWorkflowNode
  | CommandWorkflowNode
  | BuiltinWorkflowNode
  | GroupWorkflowNode
  | ParallelWorkflowNode
  | ChildWorkflowNode;

const workflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    workflowNodeBaseSchema
      .extend({
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
    workflowNodeBaseSchema
      .extend({
        kind: z.literal("workflow"),
        workflow: z.string(),
        worktree_root: z.string().optional(),
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

const runnersFileSchema = z
  .object({
    runners: strictRecord(runnerSchema).default({}),
    version: z.literal(1),
  })
  .strict();

const profilesFileSchema = z
  .object({
    mcp_gateway: mcpGatewaySchema.optional(),
    mcp_servers: strictRecord(z.never()).default({}),
    profiles: strictRecord(profileSchema).default({}),
    rules: strictRecord(pathRefSchema).default({}),
    skills: strictRecord(pathRefSchema).default({}),
    version: z.literal(1),
  })
  .strict();

const pipelineFileSchema = z
  .object({
    default_workflow: z.string(),
    entrypoints: strictRecord(entrypointSchema).default({}),
    hooks: hooksConfigSchema.default({ functions: {}, on: {} }),
    orchestrator: orchestratorSchema,
    schedules: strictRecord(schedulePolicySchema).default({}),
    task_context: taskContextResolverSchema.optional(),
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
    orchestrator: orchestratorSchema,
    profiles: strictRecord(profileSchema).default({}),
    rules: strictRecord(pathRefSchema).default({}),
    runners: strictRecord(runnerSchema).default({}),
    schedules: strictRecord(schedulePolicySchema).default({}),
    skills: strictRecord(pathRefSchema).default({}),
    task_context: taskContextResolverSchema.optional(),
    version: z.literal(1),
    workflows: strictRecord(workflowSchema).default({}),
  })
  .strict();

const configSchema = configSchemaBase.superRefine(validateConfigReferences);

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
    ]),
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
type ConfigGateSpec = NonNullable<
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

export function loadPipelineConfig(
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  const paths = [
    PIPELINE_CONFIG_PATH,
    PROFILES_CONFIG_PATH,
    RUNNERS_CONFIG_PATH,
  ];
  const missing = paths.filter((path) => !existsSync(join(projectRoot, path)));
  if (missing.length > 0) {
    const legacyPath = join(projectRoot, LEGACY_CONFIG_PATH);
    if (existsSync(legacyPath)) {
      throw new PipelineConfigError(
        "PIPELINE_CONFIG_LEGACY_UNSUPPORTED",
        `${LEGACY_CONFIG_PATH} is not supported by the v1 pipeline config. Create ${PIPELINE_CONFIG_PATH}.`,
        [{ path: LEGACY_CONFIG_PATH, message: "legacy TOML config found" }]
      );
    }
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_MISSING",
      `Missing required pipeline config files: ${missing.join(", ")}`,
      missing.map((path) => ({ path, message: "file does not exist" }))
    );
  }

  return parsePipelineConfigParts(
    {
      pipeline: readFileSync(join(projectRoot, PIPELINE_CONFIG_PATH), "utf8"),
      profiles: readFileSync(join(projectRoot, PROFILES_CONFIG_PATH), "utf8"),
      runners: readFileSync(join(projectRoot, RUNNERS_CONFIG_PATH), "utf8"),
    },
    projectRoot,
    undefined,
    options
  );
}

export function tryLoadPipelineConfig(
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig | null {
  if (!existsSync(join(projectRoot, PIPELINE_CONFIG_PATH))) {
    if (existsSync(join(projectRoot, LEGACY_CONFIG_PATH))) {
      return loadPipelineConfig(projectRoot, options);
    }
    return null;
  }
  return loadPipelineConfig(projectRoot, options);
}

export function parsePipelineConfigYaml(
  source: string,
  sourcePath = PIPELINE_CONFIG_PATH,
  projectRoot?: string
): PipelineConfig {
  return parsePipelineConfigParts(
    {
      pipeline: source,
      profiles: "version: 1\nprofiles: {}\n",
      runners: "version: 1\nrunners: {}\n",
    },
    projectRoot,
    {
      pipeline: sourcePath,
      profiles: PROFILES_CONFIG_PATH,
      runners: RUNNERS_CONFIG_PATH,
    }
  );
}

export function parsePipelineConfigParts(
  sources: PipelineConfigParts,
  projectRoot?: string,
  sourcePaths: PipelineConfigParts = {
    pipeline: PIPELINE_CONFIG_PATH,
    profiles: PROFILES_CONFIG_PATH,
    runners: RUNNERS_CONFIG_PATH,
  },
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  const runners = parseYamlAs(
    sources.runners,
    sourcePaths.runners,
    runnersFileSchema
  );
  const profiles = parseYamlAs(
    sources.profiles,
    sourcePaths.profiles,
    profilesFileSchema
  );
  const pipeline = parseYamlAs(
    sources.pipeline,
    sourcePaths.pipeline,
    pipelineFileSchema
  );
  return validatePipelineConfig(
    {
      default_workflow: pipeline.default_workflow,
      entrypoints: pipeline.entrypoints,
      hooks: pipeline.hooks,
      ...(profiles.mcp_gateway ? { mcp_gateway: profiles.mcp_gateway } : {}),
      mcp_servers: profiles.mcp_servers,
      orchestrator: pipeline.orchestrator,
      profiles: profiles.profiles,
      rules: profiles.rules,
      runners: runners.runners,
      schedules: pipeline.schedules,
      skills: profiles.skills,
      ...(pipeline.task_context ? { task_context: pipeline.task_context } : {}),
      version: 1,
      workflows: pipeline.workflows,
    },
    projectRoot,
    options
  );
}

function parseYamlAs<T extends z.ZodTypeAny>(
  source: string,
  sourcePath: string,
  schema: T
): z.infer<T> {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_PARSE_ERROR",
      `Failed to parse ${sourcePath}`,
      document.errors.map((err) => ({ message: err.message, path: sourcePath }))
    );
  }

  const parsed = schema.safeParse(document.toJS());
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }
  return parsed.data;
}

export function validatePipelineConfig(
  rawConfig: PipelineConfig,
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }

  const config = parsed.data;
  const issues: PipelineConfigIssue[] = [];

  validateRegistryIds("runners", config.runners, issues);
  validateRegistryIds("profiles", config.profiles, issues);
  validateRegistryIds("rules", config.rules, issues);
  validateRegistryIds("skills", config.skills, issues);
  validateRegistryIds("mcp_servers", config.mcp_servers, issues);
  validateRegistryIds("hooks.functions", config.hooks.functions, issues);
  validateRegistryIds("workflows", config.workflows, issues);
  validateRegistryIds("entrypoints", config.entrypoints, issues);

  const orchestratorProfile = config.profiles[config.orchestrator.profile];
  if (!orchestratorProfile) {
    issues.push({
      path: "orchestrator.profile",
      message: `orchestrator references missing profile '${config.orchestrator.profile}'`,
    });
  }

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    const runner = config.runners[profile.runner];
    if (!runner) {
      issues.push({
        path: `profiles.${profileId}.runner`,
        message: `profile '${profileId}' references missing runner '${profile.runner}'`,
      });
      continue;
    }
    validateProfile(
      profileId,
      profile,
      runner,
      config,
      issues,
      projectRoot,
      options
    );
  }

  validateHookConfig(config, issues, projectRoot, options);

  for (const [ruleId, rule] of Object.entries(config.rules)) {
    validatePath(
      `rules.${ruleId}.path`,
      rule.path,
      projectRoot,
      issues,
      options
    );
  }

  for (const [skillId, skill] of Object.entries(config.skills)) {
    validatePath(
      `skills.${skillId}.path`,
      skill.path,
      projectRoot,
      issues,
      options
    );
  }

  for (const [workflowId, workflow] of Object.entries(config.workflows)) {
    validateWorkflow(
      workflowId,
      workflow,
      config,
      issues,
      projectRoot,
      options
    );
  }

  if (issues.length > 0) {
    throw validationError(issues);
  }
  return config;
}

function validateRegistryIds(
  name: string,
  registry: Record<string, unknown>,
  issues: PipelineConfigIssue[]
): void {
  for (const id of Object.keys(registry)) {
    if (!ID_RE.test(id)) {
      issues.push({
        path: `${name}.${id}`,
        message: `registry id '${id}' must match ${ID_RE.source}`,
      });
    }
  }
}

function validateHookConfig(
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  const allowedEvents = new Set<string>(HOOK_EVENTS);
  for (const [functionId, hookFunction] of Object.entries(
    config.hooks.functions
  )) {
    validatePath(
      `hooks.functions.${functionId}.returns.schema`,
      hookFunction.returns?.schema,
      projectRoot,
      issues,
      options
    );
  }
  for (const [event, bindings] of Object.entries(config.hooks.on)) {
    if (!allowedEvents.has(event)) {
      issues.push({
        path: `hooks.on.${event}`,
        message: `unsupported hook event '${event}'`,
      });
      continue;
    }
    for (const [index, binding] of bindings.entries()) {
      if (!ID_RE.test(binding.id)) {
        issues.push({
          path: `hooks.on.${event}.${index}.id`,
          message: `hook binding id '${binding.id}' must match ${ID_RE.source}`,
        });
      }
      if (!config.hooks.functions[binding.function]) {
        issues.push({
          path: `hooks.on.${event}.${index}.function`,
          message: `hook binding '${binding.id}' references missing function '${binding.function}'`,
        });
      }
    }
  }
}

function validateProfile(
  profileId: string,
  profile: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  validateActor(
    `profile '${profileId}'`,
    `profiles.${profileId}`,
    profile,
    runner,
    config,
    issues,
    projectRoot,
    options
  );
  validateListCapability(
    `profiles.${profileId}.output.format`,
    profile.output?.format ? [profile.output.format] : undefined,
    runner.capabilities.output_formats,
    "output format",
    issues
  );

  if (profile.output?.format === "json_schema" && !profile.output.schema_path) {
    issues.push({
      path: `profiles.${profileId}.output.schema_path`,
      message: `profile '${profileId}' must declare output.schema_path for json_schema output`,
    });
  }
  const repairRunnerId = profile.output?.repair?.runner;
  if (repairRunnerId && !config.runners[repairRunnerId]) {
    issues.push({
      path: `profiles.${profileId}.output.repair.runner`,
      message: `profile '${profileId}' references missing repair runner '${repairRunnerId}'`,
    });
  }
  if (repairRunnerId && config.runners[repairRunnerId]) {
    validateListCapability(
      `profiles.${profileId}.output.repair.runner`,
      ["text"],
      config.runners[repairRunnerId].capabilities.output_formats,
      "repair output format",
      issues
    );
  }
  validatePath(
    `profiles.${profileId}.output.schema_path`,
    profile.output?.schema_path,
    projectRoot,
    issues,
    options
  );
}

function validateActor(
  label: string,
  path: string,
  actor: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  if (!(actor.instructions.path || actor.instructions.inline)) {
    issues.push({
      path: `${path}.instructions`,
      message: `${label} must declare instructions.path or instructions.inline`,
    });
  }
  validatePath(
    `${path}.instructions.path`,
    actor.instructions.path,
    projectRoot,
    issues,
    options
  );

  validateReferences(
    `${path}.rules`,
    actor.rules,
    config.rules,
    "rule",
    issues
  );
  validateReferences(
    `${path}.skills`,
    actor.skills,
    config.skills,
    "skill",
    issues
  );
  validateReferences(
    `${path}.mcp_servers`,
    actor.mcp_servers,
    config.mcp_gateway
      ? { ...config.mcp_servers, [PIPELINE_GATEWAY_SERVER_ID]: {} }
      : config.mcp_servers,
    "MCP server",
    issues
  );

  validateBooleanCapability(
    `${path}.rules`,
    actor.rules,
    runner.capabilities.rules,
    "rules",
    issues
  );
  validateBooleanCapability(
    `${path}.skills`,
    actor.skills,
    runner.capabilities.skills,
    "skills",
    issues
  );
  validateBooleanCapability(
    `${path}.mcp_servers`,
    actor.mcp_servers,
    runner.capabilities.mcp_servers,
    "MCP servers",
    issues
  );
  validateListCapability(
    `${path}.tools`,
    actor.tools,
    runner.capabilities.tools,
    "tool",
    issues
  );
  validateListCapability(
    `${path}.filesystem.mode`,
    actor.filesystem?.mode ? [actor.filesystem.mode] : undefined,
    runner.capabilities.filesystem,
    "filesystem mode",
    issues
  );
  validateListCapability(
    `${path}.network.mode`,
    actor.network?.mode ? [actor.network.mode] : undefined,
    runner.capabilities.network,
    "network mode",
    issues
  );
}

function validateWorkflow(
  workflowId: string,
  workflow: PipelineConfig["workflows"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  const nodeIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}`,
        message: `workflow '${workflowId}' declares duplicate node id '${node.id}'`,
      });
    }
    nodeIds.add(node.id);
  }

  for (const node of workflow.nodes) {
    validateWorkflowNode(workflowId, node, nodeIds, config, issues);
    validateNodeGates(workflowId, node, issues, projectRoot, options);
  }
}

function validateWorkflowNode(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  nodeIds: Set<string>,
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  if (!ID_RE.test(node.id)) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}`,
      message: `workflow node id '${node.id}' must match ${ID_RE.source}`,
    });
  }
  for (const need of node.needs ?? []) {
    if (!nodeIds.has(need)) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}.needs`,
        message: `node '${node.id}' references missing dependency '${need}'`,
      });
    }
  }
  validateWorkflowNodeKind(workflowId, node, config, issues);
  if (node.kind === "parallel") {
    validateParallelWorkflowNode(workflowId, node, config, issues);
  }
}

function validateWorkflowNodeKind(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  if (node.kind === "agent" && !config.profiles[node.profile]) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}.profile`,
      message: `node '${node.id}' references missing profile '${node.profile}'`,
    });
  }
  if (node.kind === "workflow" && !config.workflows[node.workflow]) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}.workflow`,
      message: `node '${node.id}' references missing workflow '${node.workflow}'`,
    });
  }
}

function validateParallelWorkflowNode(
  workflowId: string,
  node: Extract<
    PipelineConfig["workflows"][string]["nodes"][number],
    { kind: "parallel" }
  >,
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  const childIds = new Set<string>();
  for (const child of node.nodes) {
    if (childIds.has(child.id)) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}.nodes.${child.id}`,
        message: `parallel node '${node.id}' declares duplicate child node id '${child.id}'`,
      });
    }
    childIds.add(child.id);
  }
  for (const child of node.nodes) {
    validateWorkflowNode(workflowId, child, childIds, config, issues);
  }
}

function validateNodeGates(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  issues: PipelineConfigIssue[],
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): void {
  for (const [index, gate] of (node.gates ?? []).entries()) {
    const path = `workflows.${workflowId}.nodes.${node.id}.gates.${index}`;
    validateGateRequiredFields(gate, path, node.id, issues);
    if (gate.kind === "json_schema") {
      validatePath(
        `${path}.schema_path`,
        gate.schema_path,
        projectRoot,
        issues,
        options
      );
    }
  }
}

function validateGateRequiredFields(
  gate: ConfigGateSpec,
  path: string,
  nodeId: string,
  issues: PipelineConfigIssue[]
): void {
  const missing = gateMissingField(gate);
  if (!missing) {
    return;
  }
  issues.push({
    path: `${path}.${missing.field}`,
    message: missing.message(nodeId),
  });
}

function gateMissingField(gate: ConfigGateSpec): {
  field: string;
  message: (nodeId: string) => string;
} | null {
  if ("target" in gate && gate.target === "artifact" && !gate.path) {
    return {
      field: "path",
      message: (nodeId) =>
        `${gate.kind} artifact gate on node '${nodeId}' must declare path`,
    };
  }
  return null;
}

function validateReferences(
  path: string,
  refs: string[] | undefined,
  registry: Record<string, unknown>,
  label: string,
  issues: PipelineConfigIssue[]
): void {
  for (const ref of refs ?? []) {
    if (!registry[ref]) {
      issues.push({
        path,
        message: `references missing ${label} '${ref}'`,
      });
    }
  }
}

function validateBooleanCapability(
  path: string,
  refs: string[] | undefined,
  capability: boolean | undefined,
  label: string,
  issues: PipelineConfigIssue[]
): void {
  if ((refs?.length ?? 0) > 0 && capability !== true) {
    issues.push({
      path,
      message: `selected runner does not support ${label}`,
    });
  }
}

function validateListCapability(
  path: string,
  requested: string[] | undefined,
  supported: readonly string[] | undefined,
  label: string,
  issues: PipelineConfigIssue[]
): void {
  if (!requested || requested.length === 0) {
    return;
  }
  const allowed = new Set(supported ?? []);
  for (const item of requested) {
    if (!allowed.has(item)) {
      issues.push({
        path,
        message: `selected runner does not support ${label} '${item}'`,
      });
    }
  }
}

function validatePath(
  path: string,
  value: string | undefined,
  projectRoot: string | undefined,
  issues: PipelineConfigIssue[],
  options: PipelineConfigValidationOptions = {}
): void {
  if (!(value && projectRoot)) {
    return;
  }
  if (!existsSync(resolveFileReference(projectRoot, value))) {
    if (
      options.allowMissingLintFileReferences &&
      isLintableMissingFileReferencePath(path)
    ) {
      return;
    }
    issues.push({
      path,
      message: `referenced file '${value}' does not exist`,
    });
  }
}

const SKILLS_REGEX = /^skills\.[^.]+\.path$/;
const PROFILES_INSTRUCTIONS_REGEX = /^profiles\.[^.]+\.instructions\.path$/;
const PROFILES_OUTPUT_REGEX = /^profiles\.[^.]+\.output\.schema_path$/;

function isLintableMissingFileReferencePath(path: string): boolean {
  return (
    SKILLS_REGEX.test(path) ||
    PROFILES_INSTRUCTIONS_REGEX.test(path) ||
    PROFILES_OUTPUT_REGEX.test(path)
  );
}

function validationError(issues: PipelineConfigIssue[]): PipelineConfigError {
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
