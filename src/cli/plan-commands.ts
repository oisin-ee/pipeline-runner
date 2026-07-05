import { readFileSync } from "node:fs";

import type { Command } from "commander";

import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config";
import { formatConfigLintWarning, lintPipelineConfig } from "../config/lint";
import { compileWorkflowPlan } from "../planning/compile";
import type { PlannedWorkflowNode } from "../planning/compile";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import {
  createOrchestratorLaunchPlan,
  createRunnerLaunchPlan,
} from "../runner";
import { resolveWorkflowSelection } from "../runtime/context";

interface ValidateFlags {
  entrypoint?: string;
  lint?: boolean;
  schedule?: string;
  strict?: boolean;
  workflow?: string;
}

type WorkflowPlan = ReturnType<typeof compileWorkflowPlan>;
type ConfigLintWarning = ReturnType<typeof lintPipelineConfig>[number];

interface PlanConfigContext {
  config: PipelineConfig;
  cwd: string;
}

interface SelectedWorkflowPlan {
  config: PipelineConfig;
  plan: WorkflowPlan;
}

const loadPlanConfigContext = (): PlanConfigContext => {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const config = loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
  return { config, cwd };
};

const scheduledWorkflowPlan = (
  context: PlanConfigContext,
  schedulePath: string
): SelectedWorkflowPlan => {
  const compiled = compileScheduleArtifact(
    context.config,
    parseScheduleArtifact(readFileSync(schedulePath, "utf-8"), schedulePath),
    context.cwd
  );
  return { config: compiled.config, plan: compiled.plan };
};

const configuredWorkflowPlan = (
  context: PlanConfigContext,
  flags: ValidateFlags
): SelectedWorkflowPlan => ({
  config: context.config,
  plan: compileWorkflowPlan(
    context.config,
    resolveWorkflowSelection(context.config, flags.workflow, flags.entrypoint)
  ),
});

const selectWorkflowPlan = (
  context: PlanConfigContext,
  flags: ValidateFlags
): SelectedWorkflowPlan => {
  if (flags.schedule !== undefined && flags.schedule !== "") {
    return scheduledWorkflowPlan(context, flags.schedule);
  }
  return configuredWorkflowPlan(context, flags);
};

const lintWarnings = (
  context: PlanConfigContext,
  flags: ValidateFlags
): ConfigLintWarning[] =>
  flags.lint === false ? [] : lintPipelineConfig(context.config, context.cwd);

const emitLintWarnings = (warnings: ConfigLintWarning[]): void => {
  for (const warning of warnings) {
    console.error(formatConfigLintWarning(warning));
  }
};

const warningNoun = (count: number): string =>
  count === 1 ? "warning" : "warnings";

const assertStrictLintPass = (
  flags: ValidateFlags,
  warnings: ConfigLintWarning[]
): void => {
  if (flags.strict === true && warnings.length > 0) {
    throw new Error(
      `Validation failed with ${warnings.length} ${warningNoun(warnings.length)}.`
    );
  }
};

const formatValidationResult = (plan: WorkflowPlan): string =>
  `OK: ${plan.workflowId} (${plan.topologicalOrder.length} nodes)`;

const runValidateCommand = (flags: ValidateFlags): void => {
  const context = loadPlanConfigContext();
  const selected = selectWorkflowPlan(context, flags);
  const warnings = lintWarnings(context, flags);

  emitLintWarnings(warnings);
  assertStrictLintPass(flags, warnings);
  console.log(formatValidationResult(selected.plan));
};

const formatParallelBatch = (batch: PlannedWorkflowNode[]): string =>
  `[${batch.map((node) => node.id).join(", ")}]`;

const formatParallelBatches = (plan: WorkflowPlan): string =>
  `Batches: ${plan.parallelBatches.map(formatParallelBatch).join(" -> ")}`;

const formatParallelChildrenLine = (node: PlannedWorkflowNode): string => {
  if (
    node.kind !== "parallel" ||
    node.children === undefined ||
    node.children.length === 0
  ) {
    return "";
  }
  return `${node.id}(parallel: ${node.children.map((child) => child.id).join(", ")})`;
};

const workflowHookIds = (
  config: PipelineConfig,
  workflowId: string
): string[] =>
  Object.entries(config.hooks.on).flatMap(([event, bindings]) =>
    bindings
      .filter((binding) => binding.where?.workflow === workflowId)
      .map((binding) => `${event}:${binding.id}`)
  );

const formatWorkflowHooks = (
  config: PipelineConfig,
  workflowId: string
): string[] => {
  const hooks = workflowHookIds(config, workflowId);
  return hooks.length > 0 ? [`Workflow hooks: ${hooks.join(", ")}`] : [];
};

const formatNeeds = (node: PlannedWorkflowNode): string =>
  `needs=${node.needs.join(",") || "none"}`;

const formatRunner = (
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): string => {
  if (
    node.profile === undefined ||
    !Object.hasOwn(config.profiles, node.profile)
  ) {
    return "";
  }
  const launch = createRunnerLaunchPlan(config, {
    nodeId: node.id,
    profileId: node.profile,
    prompt: "<task>",
    worktreePath,
  });
  return `runner=${launch.runnerId}`;
};

const formatGateCount = (node: PlannedWorkflowNode): string =>
  `gates=${node.gates?.length ?? 0}`;

const formatArtifacts = (node: PlannedWorkflowNode): string => {
  const paths = node.artifacts?.map((artifact) => artifact.path) ?? [];
  return paths.length > 0 ? `artifacts=${paths.join(",")}` : "artifacts=none";
};

const formatList = (label: string, items: readonly string[] = []): string =>
  items.length > 0 ? `${label}=${items.join(",")}` : "";

const formatOrchestratorPlan = (
  config: PipelineConfig,
  worktreePath: string
): string => {
  if (!config.orchestrator) {
    return "Orchestrator: not configured";
  }
  const orchestrator = config.profiles[config.orchestrator.profile];
  const launch = createOrchestratorLaunchPlan(config, {
    nodeId: "orchestrator",
    prompt: "<task>",
    worktreePath,
  });
  return [
    `Orchestrator: runner=${launch.runnerId}`,
    orchestrator.model !== undefined && orchestrator.model !== ""
      ? `model=${orchestrator.model}`
      : "",
    formatList("rules", orchestrator.rules ?? []),
    formatList("skills", orchestrator.skills ?? []),
    formatList("mcp_servers", orchestrator.mcp_servers ?? []),
    formatList("hooks", Object.keys(config.hooks.functions)),
  ]
    .filter(isNonEmptyString)
    .join(" ");
};

const isNonEmptyString = (value: string): boolean => value.length > 0;

const formatWorkflowPlanNode = (
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): string =>
  [
    `- ${node.id}`,
    `kind=${node.kind}`,
    formatNeeds(node),
    formatRunner(node, config, worktreePath),
    formatGateCount(node),
    formatArtifacts(node),
  ]
    .filter(isNonEmptyString)
    .join(" ");

const formatWorkflowNodeLines = (
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): string[] =>
  [
    formatParallelChildrenLine(node),
    formatWorkflowPlanNode(node, config, worktreePath),
  ].filter(isNonEmptyString);

const formatWorkflowNodes = (
  plan: WorkflowPlan,
  config: PipelineConfig,
  worktreePath: string
): string[] =>
  plan.topologicalOrder.flatMap((node) =>
    formatWorkflowNodeLines(node, config, worktreePath)
  );

const formatCompiledWorkflowPlan = (
  config: PipelineConfig,
  worktreePath: string,
  plan: WorkflowPlan
): string =>
  [
    `Workflow: ${plan.workflowId}`,
    formatOrchestratorPlan(config, worktreePath),
    formatParallelBatches(plan),
    ...formatWorkflowNodes(plan, config, worktreePath),
    ...formatWorkflowHooks(config, plan.workflowId),
  ].join("\n");

const runExplainPlanCommand = (flags: ValidateFlags): void => {
  const context = loadPlanConfigContext();
  const selected = selectWorkflowPlan(context, flags);
  console.log(
    formatCompiledWorkflowPlan(selected.config, context.cwd, selected.plan)
  );
};

export const registerPlanCommands = (program: Command): void => {
  program
    .command("validate")
    .description(
      "Validate package-owned @oisincoveney/pipeline config and compile the workflow plan"
    )
    .option("--entrypoint <entrypoint>", "entrypoint id from package config")
    .option("--schedule <schedule>", "approved schedule YAML to validate")
    .option("--strict", "fail when validation lint warnings are emitted")
    .option("--no-lint", "skip validation lint warnings")
    .option("--workflow <workflow>", "workflow id from package config")
    .action((flags: ValidateFlags) => {
      runValidateCommand(flags);
    });

  program
    .command("explain-plan")
    .description("Explain nodes, runners, gates, hooks, and artifacts")
    .option("--entrypoint <entrypoint>", "entrypoint id from package config")
    .option("--schedule <schedule>", "approved schedule YAML to explain")
    .option("--workflow <workflow>", "workflow id from package config")
    .action((flags: ValidateFlags) => {
      runExplainPlanCommand(flags);
    });
};
