import { existsSync } from "node:fs";

import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";

import { PACKAGE_ASSET_ROOT } from "../package-assets";
import { resolveFileReference } from "../path-refs";
import { parseResultWithSchema } from "../schema-boundary";
import { standardOutputSchemaNameFromPath } from "../standard-output-schemas";
import {
  HOOK_EVENTS,
  ID_RE,
  PIPELINE_GATEWAY_SERVER_ID,
} from "./schema/catalog";
import {
  configIssuesFromSchemaIssues,
  configSchema,
  validationError,
} from "./schemas";
import type {
  ConfigGateSpec,
  PipelineConfig,
  PipelineConfigIssue,
  PipelineConfigValidationOptions,
} from "./schemas";

type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];
type ProfileConfig = PipelineConfig["profiles"][string];
type RunnerConfig = PipelineConfig["runners"][string];
type NodeIdSet = HashSet.HashSet<string>;

const knownNodeCategories = (config: PipelineConfig): NodeIdSet =>
  HashSet.fromIterable(
    Arr.flatMap(R.values(config.scheduler.node_catalogs), (catalog) =>
      Arr.appendAll(
        catalog.required_categories,
        Arr.map(R.values(catalog.nodes), (node) => node.category)
      )
    )
  );

const validateTokenBudget = (
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  const known = knownNodeCategories(config);
  issues.push(
    ...Arr.filterMap(
      R.keys(config.token_budget.fan_out_width.by_category),
      (category) =>
        HashSet.has(known, category)
          ? Result.failVoid
          : Result.succeed({
              message: `fan-out width cap references unknown node category '${category}'`,
              path: `token_budget.fan_out_width.by_category.${category}`,
            })
    )
  );
};

const validateRegistryIds = (
  name: string,
  registry: Record<string, unknown>,
  issues: PipelineConfigIssue[]
): void => {
  issues.push(
    ...Arr.filterMap(R.keys(registry), (id) =>
      ID_RE.test(id)
        ? Result.failVoid
        : Result.succeed({
            message: `registry id '${id}' must match ${ID_RE.source}`,
            path: `${name}.${id}`,
          })
    )
  );
};

const validateWorkflowNodeKind = (
  workflowId: string,
  node: PipelineConfig["workflows"][string]["nodes"][number],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
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
  issues: PipelineConfigIssue[]
): NodeIdSet =>
  Arr.reduce(nodes, HashSet.empty<string>(), (ids, node) => {
    if (HashSet.has(ids, node.id)) {
      issues.push(duplicateIssue(node));
    }
    return HashSet.add(ids, node.id);
  });

const validateWorkflowNode = (
  workflowId: string,
  node: WorkflowNode,
  nodeIds: NodeIdSet,
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  if (!ID_RE.test(node.id)) {
    issues.push({
      message: `workflow node id '${node.id}' must match ${ID_RE.source}`,
      path: `workflows.${workflowId}.nodes.${node.id}`,
    });
  }
  issues.push(
    ...Arr.filterMap(node.needs ?? [], (need) =>
      HashSet.has(nodeIds, need)
        ? Result.failVoid
        : Result.succeed({
            message: `node '${node.id}' references missing dependency '${need}'`,
            path: `workflows.${workflowId}.nodes.${node.id}.needs`,
          })
    )
  );
  validateWorkflowNodeKind(workflowId, node, config, issues);
  if (node.kind !== "parallel") {
    return;
  }
  const childIds = collectNodeIds(
    node.nodes,
    (child) => ({
      message: `parallel node '${node.id}' declares duplicate child node id '${child.id}'`,
      path: `workflows.${workflowId}.nodes.${node.id}.nodes.${child.id}`,
    }),
    issues
  );
  Arr.reduce(node.nodes, 0, (validated, child) => {
    validateWorkflowNode(workflowId, child, childIds, config, issues);
    return validated + 1;
  });
};

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
  issues.push(
    ...Arr.map(gateMissingFields(gate), (missing) => ({
      message: missing.message(nodeId),
      path: `${path}.${missing.field}`,
    }))
  );
};

const validateReferences = (
  path: string,
  refs: Option.Option<readonly string[]>,
  registry: Record<string, unknown>,
  label: string,
  issues: PipelineConfigIssue[]
): void => {
  issues.push(
    ...Arr.filterMap(
      Option.getOrElse(refs, () => []),
      (ref) =>
        R.has(registry, ref)
          ? Result.failVoid
          : Result.succeed({
              message: `references missing ${label} '${ref}'`,
              path,
            })
    )
  );
};

const validateBooleanCapability = (
  path: string,
  refs: Option.Option<readonly string[]>,
  capability: Option.Option<boolean>,
  label: string,
  issues: PipelineConfigIssue[]
): void => {
  if (
    Arr.isReadonlyArrayNonEmpty(Option.getOrElse(refs, () => [])) &&
    !Option.getOrElse(capability, () => false)
  ) {
    issues.push({
      message: `selected runner does not support ${label}`,
      path,
    });
  }
};

const validateListCapability = (
  path: string,
  requested: Option.Option<readonly string[]>,
  supported: Option.Option<readonly string[]>,
  label: string,
  issues: PipelineConfigIssue[]
): void => {
  const requestedItems = Option.getOrElse(requested, () => []);
  if (!Arr.isReadonlyArrayNonEmpty(requestedItems)) {
    return;
  }
  const allowed = HashSet.fromIterable<string>(
    Option.getOrElse(supported, () => [])
  );
  issues.push(
    ...Arr.filterMap(requestedItems, (item) =>
      HashSet.has(allowed, item)
        ? Result.failVoid
        : Result.succeed({
            message: `selected runner does not support ${label} '${item}'`,
            path,
          })
    )
  );
};

const optionalSingleton = <A>(
  value: Option.Option<A>
): Option.Option<readonly A[]> => value.pipe(Option.map((item) => [item]));

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
  issues: PipelineConfigIssue[],
  projectRoot = "",
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
  const allowedEvents = HashSet.fromIterable<string>(HOOK_EVENTS);
  Arr.reduce(
    R.toEntries(config.hooks.functions),
    0,
    (validated, [functionId, hookFunction]) => {
      validatePath(
        `hooks.functions.${functionId}.returns.schema`,
        { path: hookFunction.returns?.schema },
        issues,
        projectRoot,
        options
      );
      return validated + 1;
    }
  );
  Arr.reduce(
    R.toEntries(config.hooks.on),
    0,
    (validatedEvents, [event, bindings]) => {
      if (!HashSet.has(allowedEvents, event)) {
        issues.push({
          message: `unsupported hook event '${event}'`,
          path: `hooks.on.${event}`,
        });
        return validatedEvents + 1;
      }
      Arr.reduce(bindings, 0, (validatedBindings, binding, index) => {
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
        return validatedBindings + 1;
      });
      return validatedEvents + 1;
    }
  );
};

const validateActorInstructions = (
  label: string,
  path: string,
  actor: PipelineConfig["profiles"][string],
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
    issues,
    projectRoot,
    options
  );
};

const mcpServerRegistryFor = (
  config: PipelineConfig
): Record<string, unknown> =>
  config.mcp_gateway === undefined
    ? config.mcp_servers
    : { [PIPELINE_GATEWAY_SERVER_ID]: {} };

const validateActorReferences = (
  path: string,
  actor: PipelineConfig["profiles"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  validateReferences(
    `${path}.rules`,
    Option.fromUndefinedOr(actor.rules),
    config.rules,
    "rule",
    issues
  );
  validateReferences(
    `${path}.skills`,
    Option.fromUndefinedOr(actor.skills),
    config.skills,
    "skill",
    issues
  );
  validateReferences(
    `${path}.mcp_servers`,
    Option.fromUndefinedOr(actor.mcp_servers),
    mcpServerRegistryFor(config),
    "MCP server",
    issues
  );
};

const validateActorGatewayPolicy = (
  path: string,
  actor: PipelineConfig["profiles"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  if (config.mcp_gateway === undefined) {
    return;
  }
  issues.push(
    ...Arr.filterMap(actor.mcp_servers ?? [], (serverId) =>
      serverId === PIPELINE_GATEWAY_SERVER_ID
        ? Result.failVoid
        : Result.succeed({
            message:
              `${path}.mcp_servers must only reference ` +
              `${PIPELINE_GATEWAY_SERVER_ID} when mcp_gateway is configured`,
            path: `${path}.mcp_servers`,
          })
    )
  );
};

const validateActorCapabilities = (
  path: string,
  actor: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string],
  issues: PipelineConfigIssue[]
): void => {
  validateBooleanCapability(
    `${path}.rules`,
    Option.fromUndefinedOr(actor.rules),
    Option.fromUndefinedOr(runner.capabilities.rules),
    "rules",
    issues
  );
  validateBooleanCapability(
    `${path}.skills`,
    Option.fromUndefinedOr(actor.skills),
    Option.fromUndefinedOr(runner.capabilities.skills),
    "skills",
    issues
  );
  validateBooleanCapability(
    `${path}.mcp_servers`,
    Option.fromUndefinedOr(actor.mcp_servers),
    Option.fromUndefinedOr(runner.capabilities.mcp_servers),
    "MCP servers",
    issues
  );
  validateListCapability(
    `${path}.tools`,
    Option.fromUndefinedOr(actor.tools),
    Option.fromUndefinedOr(runner.capabilities.tools),
    "tool",
    issues
  );
  validateListCapability(
    `${path}.filesystem.mode`,
    optionalSingleton(Option.fromUndefinedOr(actor.filesystem?.mode)),
    Option.fromUndefinedOr(runner.capabilities.filesystem),
    "filesystem mode",
    issues
  );
  validateListCapability(
    `${path}.network.mode`,
    optionalSingleton(Option.fromUndefinedOr(actor.network?.mode)),
    Option.fromUndefinedOr(runner.capabilities.network),
    "network mode",
    issues
  );
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
  validateActorInstructions(label, path, actor, issues, projectRoot, options);
  validateActorReferences(path, actor, config, issues);
  validateActorGatewayPolicy(path, actor, config, issues);
  validateActorCapabilities(path, actor, runner, issues);
};

const configuredRepairRunnerId = (
  profile: ProfileConfig
): Option.Option<string> =>
  Option.filter(
    Option.fromUndefinedOr(profile.output?.repair?.runner),
    (runnerId) => runnerId !== ""
  );

const validateProfileOutputFormat = (
  profileId: string,
  profile: ProfileConfig,
  runner: RunnerConfig,
  issues: PipelineConfigIssue[]
): void => {
  validateListCapability(
    `profiles.${profileId}.output.format`,
    optionalSingleton(Option.fromUndefinedOr(profile.output?.format)),
    Option.fromUndefinedOr(runner.capabilities.output_formats),
    "output format",
    issues
  );
};

const validateJsonSchemaOutputRequirement = (
  profileId: string,
  profile: ProfileConfig,
  issues: PipelineConfigIssue[]
): void => {
  if (
    profile.output?.format === "json_schema" &&
    profile.output.schema_path === undefined
  ) {
    issues.push({
      message: `profile '${profileId}' must declare output.schema_path for json_schema output`,
      path: `profiles.${profileId}.output.schema_path`,
    });
  }
};

const validateProfileRepairRunner = (
  profileId: string,
  profile: ProfileConfig,
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  const repairRunnerId = configuredRepairRunnerId(profile);
  if (Option.isNone(repairRunnerId)) {
    return;
  }
  if (!R.has(config.runners, repairRunnerId.value)) {
    issues.push({
      message: `profile '${profileId}' references missing repair runner '${repairRunnerId.value}'`,
      path: `profiles.${profileId}.output.repair.runner`,
    });
    return;
  }
  validateListCapability(
    `profiles.${profileId}.output.repair.runner`,
    Option.some(["text"]),
    Option.fromUndefinedOr(
      config.runners[repairRunnerId.value].capabilities.output_formats
    ),
    "repair output format",
    issues
  );
};

const validateProfileOutputSchemaPath = (
  profileId: string,
  profile: ProfileConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): void => {
  validatePath(
    `profiles.${profileId}.output.schema_path`,
    { path: profile.output?.schema_path },
    issues,
    projectRoot,
    options
  );
};

const validateProfile = (
  profileId: string,
  profile: ProfileConfig,
  runner: RunnerConfig,
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
  validateProfileOutputFormat(profileId, profile, runner, issues);
  validateJsonSchemaOutputRequirement(profileId, profile, issues);
  validateProfileRepairRunner(profileId, profile, config, issues);
  validateProfileOutputSchemaPath(
    profileId,
    profile,
    issues,
    projectRoot,
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
  Arr.reduce(node.gates ?? [], 0, (validated, gate, index) => {
    const path = `workflows.${workflowId}.nodes.${node.id}.gates.${index}`;
    validateGateRequiredFields(gate, path, node.id, issues);
    if (gate.kind === "json_schema") {
      validatePath(
        `${path}.schema_path`,
        { path: gate.schema_path },
        issues,
        projectRoot,
        options
      );
    }
    return validated + 1;
  });
};

const validateWorkflow = (
  workflowId: string,
  workflow: PipelineConfig["workflows"][string],
  config: PipelineConfig,
  issues: PipelineConfigIssue[],
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
): void => {
  const nodeIds = collectNodeIds(
    workflow.nodes,
    (node) => ({
      message: `workflow '${workflowId}' declares duplicate node id '${node.id}'`,
      path: `workflows.${workflowId}.nodes.${node.id}`,
    }),
    issues
  );

  Arr.reduce(workflow.nodes, 0, (validated, node) => {
    validateWorkflowNode(workflowId, node, nodeIds, config, issues);
    validateNodeGates(workflowId, node, issues, projectRoot, options);
    return validated + 1;
  });
};

const validateEntrypointReferences = (
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  if (!R.has(config.workflows, config.default_workflow)) {
    issues.push({
      message: `default workflow references missing workflow '${config.default_workflow}'`,
      path: "default_workflow",
    });
  }

  Arr.reduce(
    R.toEntries(config.entrypoints),
    0,
    (validated, [entrypointId, entrypoint]) => {
      if (
        "workflow" in entrypoint &&
        !R.has(config.workflows, entrypoint.workflow)
      ) {
        issues.push({
          message: `entrypoint '${entrypointId}' references missing workflow '${entrypoint.workflow}'`,
          path: `entrypoints.${entrypointId}.workflow`,
        });
      }
      if (
        "schedule" in entrypoint &&
        !R.has(config.schedules, entrypoint.schedule)
      ) {
        issues.push({
          message: `entrypoint '${entrypointId}' references missing schedule '${entrypoint.schedule}'`,
          path: `entrypoints.${entrypointId}.schedule`,
        });
      }
      return validated + 1;
    }
  );
};

const validateScheduleReferences = (
  config: PipelineConfig,
  issues: PipelineConfigIssue[]
): void => {
  issues.push(
    ...Arr.filterMap(R.toEntries(config.schedules), ([scheduleId, schedule]) =>
      schedule.planner_profile !== undefined &&
      !R.has(config.profiles, schedule.planner_profile)
        ? Result.succeed({
            message: `schedule '${scheduleId}' references missing planner profile '${schedule.planner_profile}'`,
            path: `schedules.${scheduleId}.planner_profile`,
          })
        : Result.failVoid
    )
  );
};

export const validatePipelineConfig = (
  rawConfig: PipelineConfig,
  projectRoot = "",
  options: PipelineConfigValidationOptions = {}
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

  if (
    config.orchestrator !== undefined &&
    !R.has(config.profiles, config.orchestrator.profile)
  ) {
    issues.push({
      message: `orchestrator references missing profile '${config.orchestrator.profile}'`,
      path: "orchestrator.profile",
    });
  }

  Arr.reduce(
    R.toEntries(config.profiles),
    0,
    (validated, [profileId, profile]) => {
      if (!R.has(config.runners, profile.runner)) {
        issues.push({
          message: `profile '${profileId}' references missing runner '${profile.runner}'`,
          path: `profiles.${profileId}.runner`,
        });
        return validated + 1;
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
      return validated + 1;
    }
  );

  validateHookConfig(config, issues, projectRoot, options);
  validateTokenBudget(config, issues);
  validateEntrypointReferences(config, issues);
  validateScheduleReferences(config, issues);

  Arr.reduce(R.toEntries(config.rules), 0, (validated, [ruleId, rule]) => {
    validatePath(`rules.${ruleId}.path`, rule, issues, projectRoot, options);
    return validated + 1;
  });

  // Skill bodies are shared harness assets installed from oisin-ee/agent into
  // per-machine host dirs, so their on-disk presence is not a config-load
  // guarantee. The skill registry ids are still validated above
  // (validateRegistryIds) and profile references are checked separately; only
  // body existence is intentionally not asserted here.

  Arr.reduce(
    R.toEntries(config.workflows),
    0,
    (validated, [workflowId, workflow]) => {
      validateWorkflow(
        workflowId,
        workflow,
        config,
        issues,
        projectRoot,
        options
      );
      return validated + 1;
    }
  );

  if (issues.length > 0) {
    throw validationError(issues);
  }
  return config;
};
