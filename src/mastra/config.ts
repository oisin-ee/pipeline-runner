import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

export const PIPELINE_CONFIG_PATH = ".pipeline/pipeline.yaml";
const LEGACY_CONFIG_PATH = ".pipeline/config.toml";

const ID_RE = /^[a-z][a-z0-9-]*$/;

const RUNNER_TYPES = [
  "claude",
  "codex",
  "opencode",
  "kimi",
  "pi",
  "command",
] as const;
const NODE_KINDS = ["agent", "command", "builtin", "group"] as const;
const HOOK_EVENTS = [
  "workflow.start",
  "workflow.success",
  "workflow.failure",
  "workflow.complete",
  "node.start",
  "node.success",
  "node.error",
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
    command: z.string().min(1),
    env: z.record(z.string(), z.string()).optional(),
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

const outputSchema = z
  .object({
    format: z.enum(OUTPUT_FORMATS),
    schema_path: z.string().min(1).optional(),
  })
  .strict();

const agentSchema = z
  .object({
    description: z.string().optional(),
    filesystem: filesystemSchema.optional(),
    instructions: instructionsSchema,
    mcp_servers: z.array(z.string()).optional(),
    network: networkSchema.optional(),
    output: outputSchema.optional(),
    rules: z.array(z.string()).optional(),
    runner: z.string(),
    skills: z.array(z.string()).optional(),
    tools: z.array(z.enum(TOOL_NAMES)).optional(),
  })
  .strict();

const hookSchema = z
  .object({
    builtin: z.string().optional(),
    command: z.array(z.string()).optional(),
    event: z.enum(HOOK_EVENTS),
    kind: z.enum(["command", "builtin"]),
    required: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const workflowNodeSchema = z
  .object({
    agent: z.string().optional(),
    builtin: z.string().optional(),
    command: z.array(z.string()).optional(),
    id: z.string(),
    kind: z.enum(NODE_KINDS),
    needs: z.array(z.string()).optional(),
    nodes: z.array(z.string()).optional(),
  })
  .strict();

const workflowSchema = z
  .object({
    description: z.string().optional(),
    hooks: z.array(z.string()).optional(),
    nodes: z.array(workflowNodeSchema),
  })
  .strict();

const configSchema = z
  .object({
    agents: strictRecord(agentSchema).default({}),
    default_workflow: z.string(),
    hooks: strictRecord(hookSchema).default({}),
    mcp_servers: strictRecord(mcpServerSchema).default({}),
    rules: strictRecord(pathRefSchema).default({}),
    runners: strictRecord(runnerSchema).default({}),
    skills: strictRecord(pathRefSchema).default({}),
    version: z.literal(1),
    workflows: strictRecord(workflowSchema).default({}),
  })
  .strict();

export type PipelineConfig = z.infer<typeof configSchema>;
export type RunnerType = (typeof RUNNER_TYPES)[number];
export type WorkflowNodeKind = (typeof NODE_KINDS)[number];
export type HookEvent = (typeof HOOK_EVENTS)[number];

export function loadPipelineConfig(projectRoot: string): PipelineConfig {
  const configPath = join(projectRoot, PIPELINE_CONFIG_PATH);
  if (!existsSync(configPath)) {
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
      `Missing required pipeline config: ${PIPELINE_CONFIG_PATH}`,
      [{ path: PIPELINE_CONFIG_PATH, message: "file does not exist" }]
    );
  }

  return parsePipelineConfigYaml(
    readFileSync(configPath, "utf8"),
    configPath,
    projectRoot
  );
}

export function parsePipelineConfigYaml(
  source: string,
  sourcePath = PIPELINE_CONFIG_PATH,
  projectRoot?: string
): PipelineConfig {
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

  const parsed = configSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }

  return validatePipelineConfig(parsed.data, projectRoot);
}

export function validatePipelineConfig(
  config: PipelineConfig,
  projectRoot?: string
): PipelineConfig {
  const issues: PipelineConfigIssue[] = [];

  validateRegistryIds("runners", config.runners, issues);
  validateRegistryIds("agents", config.agents, issues);
  validateRegistryIds("rules", config.rules, issues);
  validateRegistryIds("skills", config.skills, issues);
  validateRegistryIds("mcp_servers", config.mcp_servers, issues);
  validateRegistryIds("hooks", config.hooks, issues);
  validateRegistryIds("workflows", config.workflows, issues);

  if (!config.workflows[config.default_workflow]) {
    issues.push({
      path: "default_workflow",
      message: `default workflow '${config.default_workflow}' is not declared`,
    });
  }

  for (const [agentId, agent] of Object.entries(config.agents)) {
    const runner = config.runners[agent.runner];
    if (!runner) {
      issues.push({
        path: `agents.${agentId}.runner`,
        message: `agent '${agentId}' references missing runner '${agent.runner}'`,
      });
      continue;
    }
    validateAgent(agentId, agent, runner, config, issues, projectRoot);
  }

  for (const [hookId, hook] of Object.entries(config.hooks)) {
    if (hook.kind === "command" && !hook.command) {
      issues.push({
        path: `hooks.${hookId}.command`,
        message: `command hook '${hookId}' must declare command`,
      });
    }
    if (hook.kind === "builtin" && !hook.builtin) {
      issues.push({
        path: `hooks.${hookId}.builtin`,
        message: `builtin hook '${hookId}' must declare builtin`,
      });
    }
  }

  for (const [workflowId, workflow] of Object.entries(config.workflows)) {
    validateWorkflow(workflowId, workflow, config, issues);
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

function validateAgent(
  agentId: string,
  agent: PipelineConfig["agents"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string
): void {
  if (!(agent.instructions.path || agent.instructions.inline)) {
    issues.push({
      path: `agents.${agentId}.instructions`,
      message: `agent '${agentId}' must declare instructions.path or instructions.inline`,
    });
  }
  validatePath(
    `agents.${agentId}.instructions.path`,
    agent.instructions.path,
    projectRoot,
    issues
  );

  validateReferences(
    `agents.${agentId}.rules`,
    agent.rules,
    config.rules,
    "rule",
    issues
  );
  validateReferences(
    `agents.${agentId}.skills`,
    agent.skills,
    config.skills,
    "skill",
    issues
  );
  validateReferences(
    `agents.${agentId}.mcp_servers`,
    agent.mcp_servers,
    config.mcp_servers,
    "MCP server",
    issues
  );

  validateBooleanCapability(
    `agents.${agentId}.rules`,
    agent.rules,
    runner.capabilities.rules,
    "rules",
    issues
  );
  validateBooleanCapability(
    `agents.${agentId}.skills`,
    agent.skills,
    runner.capabilities.skills,
    "skills",
    issues
  );
  validateBooleanCapability(
    `agents.${agentId}.mcp_servers`,
    agent.mcp_servers,
    runner.capabilities.mcp_servers,
    "MCP servers",
    issues
  );
  validateListCapability(
    `agents.${agentId}.tools`,
    agent.tools,
    runner.capabilities.tools,
    "tool",
    issues
  );
  validateListCapability(
    `agents.${agentId}.filesystem.mode`,
    agent.filesystem?.mode ? [agent.filesystem.mode] : undefined,
    runner.capabilities.filesystem,
    "filesystem mode",
    issues
  );
  validateListCapability(
    `agents.${agentId}.network.mode`,
    agent.network?.mode ? [agent.network.mode] : undefined,
    runner.capabilities.network,
    "network mode",
    issues
  );
  validateListCapability(
    `agents.${agentId}.output.format`,
    agent.output?.format ? [agent.output.format] : undefined,
    runner.capabilities.output_formats,
    "output format",
    issues
  );

  if (agent.output?.format === "json_schema" && !agent.output.schema_path) {
    issues.push({
      path: `agents.${agentId}.output.schema_path`,
      message: `agent '${agentId}' must declare output.schema_path for json_schema output`,
    });
  }
  validatePath(
    `agents.${agentId}.output.schema_path`,
    agent.output?.schema_path,
    projectRoot,
    issues
  );
}

function validateWorkflow(
  workflowId: string,
  workflow: PipelineConfig["workflows"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  validateReferences(
    `workflows.${workflowId}.hooks`,
    workflow.hooks,
    config.hooks,
    "hook",
    issues
  );

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
    if (node.kind === "agent" && !node.agent) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}.agent`,
        message: `agent node '${node.id}' must declare agent`,
      });
    }
    if (node.agent && !config.agents[node.agent]) {
      issues.push({
        path: `workflows.${workflowId}.nodes.${node.id}.agent`,
        message: `node '${node.id}' references missing agent '${node.agent}'`,
      });
    }
  }
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
  issues: PipelineConfigIssue[]
): void {
  if (!(value && projectRoot)) {
    return;
  }
  if (!existsSync(join(projectRoot, value))) {
    issues.push({
      path,
      message: `referenced file '${value}' does not exist`,
    });
  }
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
