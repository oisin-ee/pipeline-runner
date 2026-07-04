import { existsSync } from "node:fs";
import { PACKAGE_ASSET_ROOT } from "../package-assets";
import { resolveFileReference } from "../path-refs";
import { standardOutputSchemaNameFromPath } from "../standard-output-schemas";
import {
  HOOK_EVENTS,
  ID_RE,
  PIPELINE_GATEWAY_SERVER_ID,
} from "./schema/catalog";
import {
  type ConfigGateSpec,
  configIssuesFromZodError,
  configSchema,
  type PipelineConfig,
  type PipelineConfigIssue,
  type PipelineConfigValidationOptions,
  validationError,
} from "./schemas";

export function validatePipelineConfig(
  rawConfig: PipelineConfig,
  projectRoot?: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw validationError(configIssuesFromZodError(parsed.error));
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

  if (config.orchestrator) {
    const orchestratorProfile = config.profiles[config.orchestrator.profile];
    if (!orchestratorProfile) {
      issues.push({
        path: "orchestrator.profile",
        message: `orchestrator references missing profile '${config.orchestrator.profile}'`,
      });
    }
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
  validateTokenBudget(config, issues);

  for (const [ruleId, rule] of Object.entries(config.rules)) {
    validatePath(`rules.${ruleId}.path`, rule, projectRoot, issues, options);
  }

  // Skill bodies are shared harness assets installed from oisin-ee/agent into
  // per-machine host dirs, so their on-disk presence is not a config-load
  // guarantee. The skill registry ids are still validated above
  // (validateRegistryIds) and profile references are checked separately; only
  // body existence is intentionally not asserted here.

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

function knownNodeCategories(config: PipelineConfig): Set<string> {
  const categories = new Set<string>();
  for (const catalog of Object.values(config.scheduler.node_catalogs)) {
    for (const category of catalog.required_categories) {
      categories.add(category);
    }
    for (const node of Object.values(catalog.nodes)) {
      categories.add(node.category);
    }
  }
  return categories;
}

function validateTokenBudget(
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void {
  const known = knownNodeCategories(config);
  for (const category of Object.keys(
    config.token_budget.fan_out_width.by_category
  )) {
    if (!known.has(category)) {
      issues.push({
        path: `token_budget.fan_out_width.by_category.${category}`,
        message: `fan-out width cap references unknown node category '${category}'`,
      });
    }
  }
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
      { path: hookFunction.returns?.schema },
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
    { path: profile.output?.schema_path },
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
    { path: actor.instructions.path },
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
      ? { [PIPELINE_GATEWAY_SERVER_ID]: {} }
      : config.mcp_servers,
    "MCP server",
    issues
  );
  if (config.mcp_gateway) {
    for (const serverId of actor.mcp_servers ?? []) {
      if (serverId !== PIPELINE_GATEWAY_SERVER_ID) {
        issues.push({
          path: `${path}.mcp_servers`,
          message: `${path}.mcp_servers must only reference ${PIPELINE_GATEWAY_SERVER_ID} when mcp_gateway is configured`,
        });
      }
    }
  }

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
        { path: gate.schema_path },
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
  ref: { path?: string; source_root?: "package" | "project" },
  projectRoot: string | undefined,
  issues: PipelineConfigIssue[],
  options: PipelineConfigValidationOptions = {}
): void {
  const value = ref.path;
  if (!(value && projectRoot)) {
    return;
  }
  if (standardOutputSchemaNameFromPath(value)) {
    return;
  }
  if (!existsSync(resolvePathReference(projectRoot, ref))) {
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

function resolvePathReference(
  projectRoot: string,
  ref: { path?: string; source_root?: "package" | "project" }
): string {
  if (ref.source_root === "package") {
    return new URL(ref.path ?? "", PACKAGE_ASSET_ROOT).pathname;
  }
  return resolveFileReference(projectRoot, ref.path ?? "");
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
