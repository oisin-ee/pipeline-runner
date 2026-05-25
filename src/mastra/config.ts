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
const GATE_KINDS = ["artifact", "builtin", "command", "json_schema"] as const;
const BUILTIN_GATES = ["duplication", "test", "typecheck"] as const;

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

const artifactSchema = z
  .object({
    path: z.string().min(1),
    required: z.boolean().optional(),
  })
  .strict();

const gateSchema = z
  .object({
    builtin: z.enum(BUILTIN_GATES).optional(),
    command: z.array(z.string()).optional(),
    expect_exit_code: z.number().int().optional(),
    id: z.string().optional(),
    kind: z.enum(GATE_KINDS),
    path: z.string().min(1).optional(),
    required: z.boolean().optional(),
    schema_path: z.string().min(1).optional(),
    target: z.enum(["artifact", "stdout"]).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const retriesSchema = z
  .object({
    max_attempts: z.number().int().positive(),
  })
  .strict();

const agentSchema = z
  .object({
    description: z.string().optional(),
    filesystem: filesystemSchema.optional(),
    instructions: instructionsSchema,
    mcp_servers: z.array(z.string()).optional(),
    model: z.string().optional(),
    network: networkSchema.optional(),
    output: outputSchema.optional(),
    rules: z.array(z.string()).optional(),
    runner: z.string(),
    skills: z.array(z.string()).optional(),
    tools: z.array(z.enum(TOOL_NAMES)).optional(),
  })
  .strict();

const orchestratorSchema = z
  .object({
    filesystem: filesystemSchema.optional(),
    hooks: z.array(z.string()).optional(),
    instructions: instructionsSchema,
    mcp_servers: z.array(z.string()).optional(),
    model: z.string().optional(),
    network: networkSchema.optional(),
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
    artifacts: z.array(artifactSchema).optional(),
    builtin: z.string().optional(),
    command: z.array(z.string()).optional(),
    gates: z.array(gateSchema).optional(),
    hooks: z.array(z.string()).optional(),
    id: z.string(),
    kind: z.enum(NODE_KINDS),
    needs: z.array(z.string()).optional(),
    nodes: z.array(z.string()).optional(),
    retries: retriesSchema.optional(),
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
    orchestrator: orchestratorSchema,
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
export type GateKind = (typeof GATE_KINDS)[number];

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

  const orchestratorRunner = config.runners[config.orchestrator.runner];
  if (orchestratorRunner) {
    validateActor(
      "orchestrator",
      "orchestrator",
      config.orchestrator,
      orchestratorRunner,
      config,
      issues,
      projectRoot
    );
    validateReferences(
      "orchestrator.hooks",
      config.orchestrator.hooks,
      config.hooks,
      "hook",
      issues
    );
  } else {
    issues.push({
      path: "orchestrator.runner",
      message: `orchestrator references missing runner '${config.orchestrator.runner}'`,
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

  for (const [ruleId, rule] of Object.entries(config.rules)) {
    validatePath(`rules.${ruleId}.path`, rule.path, projectRoot, issues);
  }

  for (const [skillId, skill] of Object.entries(config.skills)) {
    validatePath(`skills.${skillId}.path`, skill.path, projectRoot, issues);
  }

  for (const [workflowId, workflow] of Object.entries(config.workflows)) {
    validateWorkflow(workflowId, workflow, config, issues, projectRoot);
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
  validateActor(
    `agent '${agentId}'`,
    `agents.${agentId}`,
    agent,
    runner,
    config,
    issues,
    projectRoot
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

function validateActor(
  label: string,
  path: string,
  actor: PipelineConfig["agents"][string] | PipelineConfig["orchestrator"],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot?: string
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
    issues
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
    config.mcp_servers,
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
  projectRoot?: string
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
    validateWorkflowNode(workflowId, node, nodeIds, config, issues);
    validateNodeGates(workflowId, node, issues, projectRoot);
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
  validateReferences(
    `workflows.${workflowId}.nodes.${node.id}.hooks`,
    node.hooks,
    config.hooks,
    "hook",
    issues
  );
  validateWorkflowNodeKind(workflowId, node, config, issues);
}

function validateWorkflowNodeKind(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
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
  if (node.kind === "command" && !node.command) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}.command`,
      message: `command node '${node.id}' must declare command`,
    });
  }
  if (node.kind === "builtin" && !node.builtin) {
    issues.push({
      path: `workflows.${workflowId}.nodes.${node.id}.builtin`,
      message: `builtin node '${node.id}' must declare builtin`,
    });
  }
}

function validateNodeGates(
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  issues: PipelineConfigIssue[],
  projectRoot?: string
): void {
  for (const [index, gate] of (node.gates ?? []).entries()) {
    const path = `workflows.${workflowId}.nodes.${node.id}.gates.${index}`;
    if (gate.kind === "command" && !gate.command) {
      issues.push({
        path: `${path}.command`,
        message: `command gate on node '${node.id}' must declare command`,
      });
    }
    if (gate.kind === "artifact" && !gate.path) {
      issues.push({
        path: `${path}.path`,
        message: `artifact gate on node '${node.id}' must declare path`,
      });
    }
    if (gate.kind === "json_schema" && !gate.schema_path) {
      issues.push({
        path: `${path}.schema_path`,
        message: `json_schema gate on node '${node.id}' must declare schema_path`,
      });
    }
    validatePath(`${path}.schema_path`, gate.schema_path, projectRoot, issues);
    if (
      gate.kind === "json_schema" &&
      gate.target === "artifact" &&
      !gate.path
    ) {
      issues.push({
        path: `${path}.path`,
        message: `json_schema artifact gate on node '${node.id}' must declare path`,
      });
    }
    if (gate.kind === "builtin" && !gate.builtin) {
      issues.push({
        path: `${path}.builtin`,
        message: `builtin gate on node '${node.id}' must declare builtin`,
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
