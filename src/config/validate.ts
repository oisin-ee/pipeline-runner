import { existsSync } from "node:fs";

import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as R from "effect/Record";

import { PACKAGE_ASSET_ROOT } from "../package-assets";
import { resolveFileReference } from "../path-refs";
import { parseResultWithSchema } from "../schema-boundary";
import { standardOutputSchemaNameFromPath } from "../standard-output-schemas";
import { HOOK_EVENTS, ID_RE, PIPELINE_GATEWAY_SERVER_ID } from "./schema/catalog";
import { configIssuesFromSchemaIssues, configSchema, validationError } from "./schemas";
import type { ConfigGateSpec, PipelineConfig, PipelineConfigIssue, PipelineConfigValidationOptions } from "./schemas";

type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];
type NodeIdSet = HashSet.HashSet<string>;

const knownNodeCategories = (config: PipelineConfig): NodeIdSet =>
  HashSet.fromIterable(
    Arr.flatMap(R.values(config.scheduler.node_catalogs), (catalog) =>
      Arr.appendAll(
        catalog.required_categories,
        Arr.map(R.values(catalog.nodes), (node) => node.category),
      ),
    ),
  );

const validateTokenBudget = (config: PipelineConfig, issues: PipelineConfigIssue[]): void => {
  const known = knownNodeCategories(config);
  Arr.forEach(R.keys(config.token_budget.fan_out_width.by_category), (category) => {
    if (!HashSet.has(known, category)) {
      issues.push({
        message: `fan-out width cap references unknown node category '${category}'`,
        path: `token_budget.fan_out_width.by_category.${category}`,
      });
    }
  });
};

const validateRegistryIds = (name: string, registry: Record<string, unknown>, issues: PipelineConfigIssue[]): void => {
  Arr.forEach(R.keys(registry), (id) => {
    if (!ID_RE.test(id)) {
      issues.push({
        message: `registry id '${id}' must match ${ID_RE.source}`,
        path: `${name}.${id}`,
      });
    }
  });
};

const validateWorkflowNodeKind = (
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
): void => {
  if (node.kind === "agent" && !R.has(config.profiles, node.profile)) {
    issues.push({
      message: `node '${node.id}' references missing profile '${node.profile}'`,
      path: `workflows.${workflowId}.nodes.${node.id}.profile`,
    });
  }
};

const collectNodeIds = (
  nodes: readonly WorkflowNode[],
  duplicateIssue: (node: WorkflowNode) => PipelineConfigIssue,
  issues: PipelineConfigIssue[],
): NodeIdSet =>
  Arr.reduce(nodes, HashSet.empty<string>(), (ids, node) => {
    if (HashSet.has(ids, node.id)) {
      issues.push(duplicateIssue(node));
    }
    return HashSet.add(ids, node.id);
  });

const validateParallelWorkflowNode = (
  workflowId: string,
  node: Extract<WorkflowNode, { kind: "parallel" }>,
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
): void => {
  const childIds = collectNodeIds(
    node.nodes,
    (child) => ({
      message: `parallel node '${node.id}' declares duplicate child node id '${child.id}'`,
      path: `workflows.${workflowId}.nodes.${node.id}.nodes.${child.id}`,
    }),
    issues,
  );
  Arr.forEach(node.nodes, (child) => {
    validateWorkflowNode(workflowId, child, childIds, config, issues);
  });
};

const validateWorkflowNode = (
  workflowId: string,
  node: WorkflowNode,
  nodeIds: NodeIdSet,
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
): void => {
  if (!ID_RE.test(node.id)) {
    issues.push({
      message: `workflow node id '${node.id}' must match ${ID_RE.source}`,
      path: `workflows.${workflowId}.nodes.${node.id}`,
    });
  }
  Arr.forEach(node.needs ?? [], (need) => {
    if (!HashSet.has(nodeIds, need)) {
      issues.push({
        message: `node '${node.id}' references missing dependency '${need}'`,
        path: `workflows.${workflowId}.nodes.${node.id}.needs`,
      });
    }
  });
  validateWorkflowNodeKind(workflowId, node, config, issues);
  if (node.kind === "parallel") {
    validateParallelWorkflowNode(workflowId, node, config, issues);
  }
};

const gateMissingFields = (
  gate: ConfigGateSpec,
): {
  field: string;
  message: (nodeId: string) => string;
}[] => {
  if ("target" in gate && gate.target === "artifact" && gate.path === undefined) {
    return [
      {
        field: "path",
        message: (nodeId) => `${gate.kind} artifact gate on node '${nodeId}' must declare path`,
      },
    ];
  }
  return [];
};

const validateGateRequiredFields = (
  gate: ConfigGateSpec,
  path: string,
  nodeId: string,
  issues: PipelineConfigIssue[],
): void => {
  Arr.forEach(gateMissingFields(gate), (missing) => {
    issues.push({
      message: missing.message(nodeId),
      path: `${path}.${missing.field}`,
    });
  });
};

const validateReferences = (
  path: string,
  refs: string[] = [],
  registry: Record<string, unknown>,
  label: string,
  issues: PipelineConfigIssue[],
): void => {
  Arr.forEach(refs, (ref) => {
    if (!R.has(registry, ref)) {
      issues.push({
        message: `references missing ${label} '${ref}'`,
        path,
      });
    }
  });
};

const validateBooleanCapability = (
  path: string,
  refs: string[] = [],
  capability = false,
  label: string,
  issues: PipelineConfigIssue[],
): void => {
  if (Arr.isReadonlyArrayNonEmpty(refs) && !capability) {
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
  issues: PipelineConfigIssue[],
): void => {
  if (!Arr.isReadonlyArrayNonEmpty(requested)) {
    return;
  }
  const allowed = HashSet.fromIterable<string>(supported);
  Arr.forEach(requested, (item) => {
    if (!HashSet.has(allowed, item)) {
      issues.push({
        message: `selected runner does not support ${label} '${item}'`,
        path,
      });
    }
  });
};

const resolvePathReference = (
  projectRoot: string,
  ref: { path?: string; source_root?: "package" | "project" },
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
  SKILLS_REGEX.test(path) || PROFILES_INSTRUCTIONS_REGEX.test(path) || PROFILES_OUTPUT_REGEX.test(path);

const validatePath = (
  path: string,
  ref: { path?: string; source_root?: "package" | "project" },
  projectRoot = "",
  issues: PipelineConfigIssue[],
  options: PipelineConfigValidationOptions = {},
): void => {
  const value = ref.path;
  if (value === undefined || value === "" || projectRoot === "") {
    return;
  }
  if (standardOutputSchemaNameFromPath(value)) {
    return;
  }
  if (!existsSync(resolvePathReference(projectRoot, ref))) {
    if (options.allowMissingLintFileReferences === true && isLintableMissingFileReferencePath(path)) {
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
  options: PipelineConfigValidationOptions = {},
): void => {
  const allowedEvents = HashSet.fromIterable<string>(HOOK_EVENTS);
  Arr.forEach(R.toEntries(config.hooks.functions), ([functionId, hookFunction]) => {
    validatePath(
      `hooks.functions.${functionId}.returns.schema`,
      { path: hookFunction.returns?.schema },
      projectRoot,
      issues,
      options,
    );
  });
  Arr.forEach(R.toEntries(config.hooks.on), ([event, bindings]) => {
    if (!HashSet.has(allowedEvents, event)) {
      issues.push({
        message: `unsupported hook event '${event}'`,
        path: `hooks.on.${event}`,
      });
      return;
    }
    Arr.forEach(bindings, (binding, index) => {
      if (!ID_RE.test(binding.id)) {
        issues.push({
          message: `hook binding id '${binding.id}' must match ${ID_RE.source}`,
          path: `hooks.on.${event}.${index}.id`,
        });
      }
      if (!R.has(config.hooks.functions, binding.function)) {
        issues.push({
          message: `hook binding '${binding.id}' references missing function '${binding.function}'`,
          path: `hooks.on.${event}.${index}.function`,
        });
      }
    });
  });
};

const validateActor = (
  label: string,
  path: string,
  actor: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {},
): void => {
  if (actor.instructions.path === undefined && actor.instructions.inline === undefined) {
    issues.push({
      message: `${label} must declare instructions.path or instructions.inline`,
      path: `${path}.instructions`,
    });
  }
  validatePath(`${path}.instructions.path`, { path: actor.instructions.path }, projectRoot, issues, options);

  validateReferences(`${path}.rules`, actor.rules, config.rules, "rule", issues);
  validateReferences(`${path}.skills`, actor.skills, config.skills, "skill", issues);
  validateReferences(
    `${path}.mcp_servers`,
    actor.mcp_servers,
    config.mcp_gateway === undefined ? config.mcp_servers : { [PIPELINE_GATEWAY_SERVER_ID]: {} },
    "MCP server",
    issues,
  );
  if (config.mcp_gateway !== undefined) {
    Arr.forEach(actor.mcp_servers ?? [], (serverId) => {
      if (serverId !== PIPELINE_GATEWAY_SERVER_ID) {
        issues.push({
          message:
            `${path}.mcp_servers must only reference ` + `${PIPELINE_GATEWAY_SERVER_ID} when mcp_gateway is configured`,
          path: `${path}.mcp_servers`,
        });
      }
    });
  }

  validateBooleanCapability(`${path}.rules`, actor.rules, runner.capabilities.rules, "rules", issues);
  validateBooleanCapability(`${path}.skills`, actor.skills, runner.capabilities.skills, "skills", issues);
  validateBooleanCapability(
    `${path}.mcp_servers`,
    actor.mcp_servers,
    runner.capabilities.mcp_servers,
    "MCP servers",
    issues,
  );
  validateListCapability(`${path}.tools`, actor.tools, runner.capabilities.tools, "tool", issues);
  validateListCapability(
    `${path}.filesystem.mode`,
    actor.filesystem?.mode === undefined ? [] : [actor.filesystem.mode],
    runner.capabilities.filesystem,
    "filesystem mode",
    issues,
  );
  validateListCapability(
    `${path}.network.mode`,
    actor.network?.mode === undefined ? [] : [actor.network.mode],
    runner.capabilities.network,
    "network mode",
    issues,
  );
};

const validateProfile = (
  profileId: string,
  profile: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {},
): void => {
  validateActor(
    `profile '${profileId}'`,
    `profiles.${profileId}`,
    profile,
    runner,
    config,
    issues,
    projectRoot,
    options,
  );
  validateListCapability(
    `profiles.${profileId}.output.format`,
    profile.output?.format === undefined ? [] : [profile.output.format],
    runner.capabilities.output_formats,
    "output format",
    issues,
  );

  if (profile.output?.format === "json_schema" && profile.output.schema_path === undefined) {
    issues.push({
      message: `profile '${profileId}' must declare output.schema_path for json_schema output`,
      path: `profiles.${profileId}.output.schema_path`,
    });
  }
  const repairRunnerId = profile.output?.repair?.runner;
  if (repairRunnerId !== undefined && repairRunnerId !== "" && !R.has(config.runners, repairRunnerId)) {
    issues.push({
      message: `profile '${profileId}' references missing repair runner '${repairRunnerId}'`,
      path: `profiles.${profileId}.output.repair.runner`,
    });
  }
  if (repairRunnerId !== undefined && repairRunnerId !== "" && R.has(config.runners, repairRunnerId)) {
    validateListCapability(
      `profiles.${profileId}.output.repair.runner`,
      ["text"],
      config.runners[repairRunnerId].capabilities.output_formats,
      "repair output format",
      issues,
    );
  }
  validatePath(
    `profiles.${profileId}.output.schema_path`,
    { path: profile.output?.schema_path },
    projectRoot,
    issues,
    options,
  );
};

const validateNodeGates = (
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {},
): void => {
  Arr.forEach(node.gates ?? [], (gate, index) => {
    const path = `workflows.${workflowId}.nodes.${node.id}.gates.${index}`;
    validateGateRequiredFields(gate, path, node.id, issues);
    if (gate.kind === "json_schema") {
      validatePath(`${path}.schema_path`, { path: gate.schema_path }, projectRoot, issues, options);
    }
  });
};

const validateWorkflow = (
  workflowId: string,
  workflow: PipelineConfig["workflows"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {},
): void => {
  const nodeIds = collectNodeIds(
    workflow.nodes,
    (node) => ({
      message: `workflow '${workflowId}' declares duplicate node id '${node.id}'`,
      path: `workflows.${workflowId}.nodes.${node.id}`,
    }),
    issues,
  );

  Arr.forEach(workflow.nodes, (node) => {
    validateWorkflowNode(workflowId, node, nodeIds, config, issues);
    validateNodeGates(workflowId, node, issues, projectRoot, options);
  });
};

const validateEntrypointReferences = (config: PipelineConfig, issues: PipelineConfigIssue[]): void => {
  if (!R.has(config.workflows, config.default_workflow)) {
    issues.push({
      message: `default workflow references missing workflow '${config.default_workflow}'`,
      path: "default_workflow",
    });
  }

  Arr.forEach(R.toEntries(config.entrypoints), ([entrypointId, entrypoint]) => {
    if ("workflow" in entrypoint && !R.has(config.workflows, entrypoint.workflow)) {
      issues.push({
        message: `entrypoint '${entrypointId}' references missing workflow '${entrypoint.workflow}'`,
        path: `entrypoints.${entrypointId}.workflow`,
      });
    }
    if ("schedule" in entrypoint && !R.has(config.schedules, entrypoint.schedule)) {
      issues.push({
        message: `entrypoint '${entrypointId}' references missing schedule '${entrypoint.schedule}'`,
        path: `entrypoints.${entrypointId}.schedule`,
      });
    }
  });
};

const validateScheduleReferences = (config: PipelineConfig, issues: PipelineConfigIssue[]): void => {
  Arr.forEach(R.toEntries(config.schedules), ([scheduleId, schedule]) => {
    if (schedule.planner_profile !== undefined && !R.has(config.profiles, schedule.planner_profile)) {
      issues.push({
        message: `schedule '${scheduleId}' references missing planner profile '${schedule.planner_profile}'`,
        path: `schedules.${scheduleId}.planner_profile`,
      });
    }
  });
};

export const validatePipelineConfig = (
  rawConfig: PipelineConfig,
  projectRoot = "",
  options: PipelineConfigValidationOptions = {},
): PipelineConfig => {
  const parsed = parseResultWithSchema(configSchema, rawConfig, {
    onExcessProperty: "error",
  });
  if (!parsed.ok) {
    throw validationError(configIssuesFromSchemaIssues(parsed.issues));
  }

  const config = parsed.value;
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
    if (!R.has(config.profiles, config.orchestrator.profile)) {
      issues.push({
        message: `orchestrator references missing profile '${config.orchestrator.profile}'`,
        path: "orchestrator.profile",
      });
    }
  }

  Arr.forEach(R.toEntries(config.profiles), ([profileId, profile]) => {
    if (!R.has(config.runners, profile.runner)) {
      issues.push({
        message: `profile '${profileId}' references missing runner '${profile.runner}'`,
        path: `profiles.${profileId}.runner`,
      });
      return;
    }
    const runner = config.runners[profile.runner];
    validateProfile(profileId, profile, runner, config, issues, projectRoot, options);
  });

  validateHookConfig(config, issues, projectRoot, options);
  validateTokenBudget(config, issues);
  validateEntrypointReferences(config, issues);
  validateScheduleReferences(config, issues);

  Arr.forEach(R.toEntries(config.rules), ([ruleId, rule]) => {
    validatePath(`rules.${ruleId}.path`, rule, projectRoot, issues, options);
  });

  // Skill bodies are shared harness assets installed from oisin-ee/agent into
  // per-machine host dirs, so their on-disk presence is not a config-load
  // guarantee. The skill registry ids are still validated above
  // (validateRegistryIds) and profile references are checked separately; only
  // body existence is intentionally not asserted here.

  Arr.forEach(R.toEntries(config.workflows), ([workflowId, workflow]) => {
    validateWorkflow(workflowId, workflow, config, issues, projectRoot, options);
  });

  if (issues.length > 0) {
    throw validationError(issues);
  }
  return config;
};
