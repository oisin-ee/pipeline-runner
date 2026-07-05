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
  configIssuesFromZodError,
  configSchema,
  validationError,
} from "./schemas";
import type {
  ConfigGateSpec,
  PipelineConfig,
  PipelineConfigIssue,
  PipelineConfigValidationOptions,
} from "./schemas";

const knownNodeCategories = (config: PipelineConfig): Set<string> => {
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
};

const validateTokenBudget = (
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  const known = knownNodeCategories(config);
  for (const category of Object.keys(
    config.token_budget.fan_out_width.by_category
  )) {
    if (!known.has(category)) {
      issues.push({
        message: `fan-out width cap references unknown node category '${category}'`,
        path: `token_budget.fan_out_width.by_category.${category}`,
      });
    }
  }
};

const validateRegistryIds = (
  name: string,
  registry: Record<string, unknown>,
  issues: PipelineConfigIssue[]
): void => {
  for (const id of Object.keys(registry)) {
    if (!ID_RE.test(id)) {
      issues.push({
        message: `registry id '${id}' must match ${ID_RE.source}`,
        path: `${name}.${id}`,
      });
    }
  }
};

const validateWorkflowNodeKind = (
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  if (node.kind === "agent" && !Object.hasOwn(config.profiles, node.profile)) {
    issues.push({
      message: `node '${node.id}' references missing profile '${node.profile}'`,
      path: `workflows.${workflowId}.nodes.${node.id}.profile`,
    });
  }
};

const workflowNodeValidators = {
  validateParallelWorkflowNode(
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
          message: `parallel node '${node.id}' declares duplicate child node id '${child.id}'`,
          path: `workflows.${workflowId}.nodes.${node.id}.nodes.${child.id}`,
        });
      }
      childIds.add(child.id);
    }
    for (const child of node.nodes) {
      workflowNodeValidators.validateWorkflowNode(
        workflowId,
        child,
        childIds,
        config,
        issues
      );
    }
  },
  validateWorkflowNode(
    workflowId: string,
    node: PipelineConfig["workflows"][string]["nodes"][number],
    nodeIds: Set<string>,
    config: PipelineConfig,
    issues: PipelineConfigIssue[]
  ): void {
    if (!ID_RE.test(node.id)) {
      issues.push({
        message: `workflow node id '${node.id}' must match ${ID_RE.source}`,
        path: `workflows.${workflowId}.nodes.${node.id}`,
      });
    }
    for (const need of node.needs ?? []) {
      if (!nodeIds.has(need)) {
        issues.push({
          message: `node '${node.id}' references missing dependency '${need}'`,
          path: `workflows.${workflowId}.nodes.${node.id}.needs`,
        });
      }
    }
    validateWorkflowNodeKind(workflowId, node, config, issues);
    if (node.kind === "parallel") {
      workflowNodeValidators.validateParallelWorkflowNode(
        workflowId,
        node,
        config,
        issues
      );
    }
  },
};

const { validateWorkflowNode } = workflowNodeValidators;

const gateMissingFields = (
  gate: ConfigGateSpec
): {
  field: string;
  message: (nodeId: string) => string;
}[] => {
  if (
    "target" in gate &&
    gate.target === "artifact" &&
    gate.path === undefined
  ) {
    return [
      {
        field: "path",
        message: (nodeId) =>
          `${gate.kind} artifact gate on node '${nodeId}' must declare path`,
      },
    ];
  }
  return [];
};

const validateGateRequiredFields = (
  gate: ConfigGateSpec,
  path: string,
  nodeId: string,
  issues: PipelineConfigIssue[]
): void => {
  for (const missing of gateMissingFields(gate)) {
    issues.push({
      message: missing.message(nodeId),
      path: `${path}.${missing.field}`,
    });
  }
};

const validateReferences = (
  path: string,
  refs: string[] = [],
  registry: Record<string, unknown>,
  label: string,
  issues: PipelineConfigIssue[]
): void => {
  for (const ref of refs) {
    if (!Object.hasOwn(registry, ref)) {
      issues.push({
        message: `references missing ${label} '${ref}'`,
        path,
      });
    }
  }
};

const validateBooleanCapability = (
  path: string,
  refs: string[] = [],
  capability = false,
  label: string,
  issues: PipelineConfigIssue[]
): void => {
  if (refs.length > 0 && !capability) {
    issues.push({
      message: `selected runner does not support ${label}`,
      path,
    });
  }
};

const validateListCapability = (
  path: string,
  requested: string[] = [],
  supported: readonly string[] = [],
  label: string,
  issues: PipelineConfigIssue[]
): void => {
  if (requested.length === 0) {
    return;
  }
  const allowed = new Set(supported);
  for (const item of requested) {
    if (!allowed.has(item)) {
      issues.push({
        message: `selected runner does not support ${label} '${item}'`,
        path,
      });
    }
  }
};

const resolvePathReference = (
  projectRoot: string,
  ref: { path?: string; source_root?: "package" | "project" }
): string => {
  if (ref.source_root === "package") {
    return new URL(ref.path ?? "", PACKAGE_ASSET_ROOT).pathname;
  }
  return resolveFileReference(projectRoot, ref.path ?? "");
};

const SKILLS_REGEX = /^skills\.[^.]+\.path$/u;
const PROFILES_INSTRUCTIONS_REGEX = /^profiles\.[^.]+\.instructions\.path$/u;
const PROFILES_OUTPUT_REGEX = /^profiles\.[^.]+\.output\.schema_path$/u;

const isLintableMissingFileReferencePath = (path: string): boolean =>
  SKILLS_REGEX.test(path) ||
  PROFILES_INSTRUCTIONS_REGEX.test(path) ||
  PROFILES_OUTPUT_REGEX.test(path);

const validatePath = (
  path: string,
  ref: { path?: string; source_root?: "package" | "project" },
  projectRoot = "",
  issues: PipelineConfigIssue[],
  options: PipelineConfigValidationOptions = {}
): void => {
  const value = ref.path;
  if (value === undefined || value === "" || projectRoot === "") {
    return;
  }
  if (standardOutputSchemaNameFromPath(value)) {
    return;
  }
  if (!existsSync(resolvePathReference(projectRoot, ref))) {
    if (
      options.allowMissingLintFileReferences === true &&
      isLintableMissingFileReferencePath(path)
    ) {
      return;
    }
    issues.push({
      message: `referenced file '${value}' does not exist`,
      path,
    });
  }
};

const validateHookConfig = (
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): void => {
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
        message: `unsupported hook event '${event}'`,
        path: `hooks.on.${event}`,
      });
      continue;
    }
    for (const [index, binding] of bindings.entries()) {
      if (!ID_RE.test(binding.id)) {
        issues.push({
          message: `hook binding id '${binding.id}' must match ${ID_RE.source}`,
          path: `hooks.on.${event}.${index}.id`,
        });
      }
      if (!Object.hasOwn(config.hooks.functions, binding.function)) {
        issues.push({
          message: `hook binding '${binding.id}' references missing function '${binding.function}'`,
          path: `hooks.on.${event}.${index}.function`,
        });
      }
    }
  }
};

const validateActor = (
  label: string,
  path: string,
  actor: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): void => {
  if (
    actor.instructions.path === undefined &&
    actor.instructions.inline === undefined
  ) {
    issues.push({
      message: `${label} must declare instructions.path or instructions.inline`,
      path: `${path}.instructions`,
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
    config.mcp_gateway === undefined
      ? config.mcp_servers
      : { [PIPELINE_GATEWAY_SERVER_ID]: {} },
    "MCP server",
    issues
  );
  if (config.mcp_gateway !== undefined) {
    for (const serverId of actor.mcp_servers ?? []) {
      if (serverId !== PIPELINE_GATEWAY_SERVER_ID) {
        issues.push({
          message: `${path}.mcp_servers must only reference ${PIPELINE_GATEWAY_SERVER_ID} when mcp_gateway is configured`,
          path: `${path}.mcp_servers`,
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
    actor.filesystem?.mode === undefined ? [] : [actor.filesystem.mode],
    runner.capabilities.filesystem,
    "filesystem mode",
    issues
  );
  validateListCapability(
    `${path}.network.mode`,
    actor.network?.mode === undefined ? [] : [actor.network.mode],
    runner.capabilities.network,
    "network mode",
    issues
  );
};

const validateProfile = (
  profileId: string,
  profile: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): void => {
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
    profile.output?.format === undefined ? [] : [profile.output.format],
    runner.capabilities.output_formats,
    "output format",
    issues
  );

  if (
    profile.output?.format === "json_schema" &&
    profile.output.schema_path === undefined
  ) {
    issues.push({
      message: `profile '${profileId}' must declare output.schema_path for json_schema output`,
      path: `profiles.${profileId}.output.schema_path`,
    });
  }
  const repairRunnerId = profile.output?.repair?.runner;
  if (
    repairRunnerId !== undefined &&
    repairRunnerId !== "" &&
    !Object.hasOwn(config.runners, repairRunnerId)
  ) {
    issues.push({
      message: `profile '${profileId}' references missing repair runner '${repairRunnerId}'`,
      path: `profiles.${profileId}.output.repair.runner`,
    });
  }
  if (
    repairRunnerId !== undefined &&
    repairRunnerId !== "" &&
    Object.hasOwn(config.runners, repairRunnerId)
  ) {
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
};

const validateNodeGates = (
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): void => {
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
};

const validateWorkflow = (
  workflowId: string,
  workflow: PipelineConfig["workflows"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): void => {
  const nodeIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        message: `workflow '${workflowId}' declares duplicate node id '${node.id}'`,
        path: `workflows.${workflowId}.nodes.${node.id}`,
      });
    }
    nodeIds.add(node.id);
  }

  for (const node of workflow.nodes) {
    validateWorkflowNode(workflowId, node, nodeIds, config, issues);
    validateNodeGates(workflowId, node, issues, projectRoot, options);
  }
};

export const validatePipelineConfig = (
  rawConfig: PipelineConfig,
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): PipelineConfig => {
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

  if (config.orchestrator !== undefined) {
    if (!Object.hasOwn(config.profiles, config.orchestrator.profile)) {
      issues.push({
        message: `orchestrator references missing profile '${config.orchestrator.profile}'`,
        path: "orchestrator.profile",
      });
    }
  }

  for (const [profileId, profile] of Object.entries(config.profiles)) {
    if (!Object.hasOwn(config.runners, profile.runner)) {
      issues.push({
        message: `profile '${profileId}' references missing runner '${profile.runner}'`,
        path: `profiles.${profileId}.runner`,
      });
      continue;
    }
    const runner = config.runners[profile.runner];
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
};
