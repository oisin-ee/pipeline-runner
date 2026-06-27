import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config";
import { formatConfigLintWarning, lintPipelineConfig } from "../config/lint";
import {
  compileWorkflowPlan,
  type PlannedWorkflowNode,
} from "../planning/compile";
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

export function registerPlanCommands(program: Command): void {
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
    .action((flags: ValidateFlags) => runValidateCommand(flags));

  program
    .command("explain-plan")
    .description("Explain nodes, runners, gates, hooks, and artifacts")
    .option("--entrypoint <entrypoint>", "entrypoint id from package config")
    .option("--schedule <schedule>", "approved schedule YAML to explain")
    .option("--workflow <workflow>", "workflow id from package config")
    .action((flags: ValidateFlags) => runExplainPlanCommand(flags));
}

function runValidateCommand(flags: ValidateFlags): void {
  const context = loadPlanConfigContext();
  const selected = selectWorkflowPlan(context, flags);
  const warnings = lintWarnings(context, flags);

  emitLintWarnings(warnings);
  assertStrictLintPass(flags, warnings);
  console.log(formatValidationResult(selected.plan));
}

function runExplainPlanCommand(flags: ValidateFlags): void {
  const context = loadPlanConfigContext();
  const selected = selectWorkflowPlan(context, flags);
  console.log(
    formatCompiledWorkflowPlan(selected.config, context.cwd, selected.plan)
  );
}

function loadPlanConfigContext(): PlanConfigContext {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const config = loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
  return { config, cwd };
}

function selectWorkflowPlan(
  context: PlanConfigContext,
  flags: ValidateFlags
): SelectedWorkflowPlan {
  if (flags.schedule) {
    return scheduledWorkflowPlan(context, flags.schedule);
  }
  return configuredWorkflowPlan(context, flags);
}

function scheduledWorkflowPlan(
  context: PlanConfigContext,
  schedulePath: string
): SelectedWorkflowPlan {
  const compiled = compileScheduleArtifact(
    context.config,
    parseScheduleArtifact(readFileSync(schedulePath, "utf8"), schedulePath),
    context.cwd
  );
  return { config: compiled.config, plan: compiled.plan };
}

function configuredWorkflowPlan(
  context: PlanConfigContext,
  flags: ValidateFlags
): SelectedWorkflowPlan {
  return {
    config: context.config,
    plan: compileWorkflowPlan(
      context.config,
      resolveWorkflowSelection(context.config, flags.workflow, flags.entrypoint)
    ),
  };
}

function lintWarnings(
  context: PlanConfigContext,
  flags: ValidateFlags
): ConfigLintWarning[] {
  return flags.lint === false
    ? []
    : lintPipelineConfig(context.config, context.cwd);
}

function emitLintWarnings(warnings: ConfigLintWarning[]): void {
  for (const warning of warnings) {
    console.error(formatConfigLintWarning(warning));
  }
}

function assertStrictLintPass(
  flags: ValidateFlags,
  warnings: ConfigLintWarning[]
): void {
  if (flags.strict && warnings.length > 0) {
    throw new Error(
      `Validation failed with ${warnings.length} ${warningNoun(warnings.length)}.`
    );
  }
}

function warningNoun(count: number): string {
  return count === 1 ? "warning" : "warnings";
}

function formatValidationResult(plan: WorkflowPlan): string {
  return `OK: ${plan.workflowId} (${plan.topologicalOrder.length} nodes)`;
}

function formatCompiledWorkflowPlan(
  config: PipelineConfig,
  worktreePath: string,
  plan: WorkflowPlan
): string {
  return [
    `Workflow: ${plan.workflowId}`,
    formatOrchestratorPlan(config, worktreePath),
    formatParallelBatches(plan),
    ...formatWorkflowNodes(plan, config, worktreePath),
    ...formatWorkflowHooks(config, plan.workflowId),
  ].join("\n");
}

function formatParallelBatches(plan: WorkflowPlan): string {
  return `Batches: ${plan.parallelBatches.map(formatParallelBatch).join(" -> ")}`;
}

function formatParallelBatch(batch: PlannedWorkflowNode[]): string {
  return `[${batch.map((node) => node.id).join(", ")}]`;
}

function formatWorkflowNodes(
  plan: WorkflowPlan,
  config: PipelineConfig,
  worktreePath: string
): string[] {
  return plan.topologicalOrder.flatMap((node) =>
    formatWorkflowNodeLines(node, config, worktreePath)
  );
}

function formatWorkflowNodeLines(
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): string[] {
  return [
    formatParallelChildrenLine(node),
    formatWorkflowPlanNode(node, config, worktreePath),
  ].filter(isNonEmptyString);
}

function formatParallelChildrenLine(node: PlannedWorkflowNode): string {
  if (node.kind !== "parallel" || !node.children?.length) {
    return "";
  }
  return `${node.id}(parallel: ${node.children.map((child) => child.id).join(", ")})`;
}

function formatWorkflowHooks(
  config: PipelineConfig,
  workflowId: string
): string[] {
  const hooks = workflowHookIds(config, workflowId);
  return hooks.length > 0 ? [`Workflow hooks: ${hooks.join(", ")}`] : [];
}

function workflowHookIds(config: PipelineConfig, workflowId: string): string[] {
  return Object.entries(config.hooks.on).flatMap(([event, bindings]) =>
    bindings
      .filter((binding) => binding.where?.workflow === workflowId)
      .map((binding) => `${event}:${binding.id}`)
  );
}

function formatWorkflowPlanNode(
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): string {
  return [
    `- ${node.id}`,
    `kind=${node.kind}`,
    formatNeeds(node),
    formatRunner(node, config, worktreePath),
    formatGateCount(node),
    formatArtifacts(node),
  ]
    .filter(isNonEmptyString)
    .join(" ");
}

function formatNeeds(node: PlannedWorkflowNode): string {
  return `needs=${node.needs.join(",") || "none"}`;
}

function formatRunner(
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): string {
  const launch = runnerLaunchPlan(node, config, worktreePath);
  return launch ? `runner=${launch.runnerId}` : "";
}

function runnerLaunchPlan(
  node: PlannedWorkflowNode,
  config: PipelineConfig,
  worktreePath: string
): ReturnType<typeof createRunnerLaunchPlan> | null {
  if (!node.profile) {
    return null;
  }
  if (!config.profiles[node.profile]) {
    return null;
  }
  return createRunnerLaunchPlan(config, {
    nodeId: node.id,
    profileId: node.profile,
    prompt: "<task>",
    worktreePath,
  });
}

function formatGateCount(node: PlannedWorkflowNode): string {
  return `gates=${node.gates?.length ?? 0}`;
}

function formatArtifacts(node: PlannedWorkflowNode): string {
  const paths = node.artifacts?.map((artifact) => artifact.path) ?? [];
  return paths.length > 0 ? `artifacts=${paths.join(",")}` : "artifacts=none";
}

function formatOrchestratorPlan(
  config: PipelineConfig,
  worktreePath: string
): string {
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
    orchestrator.model ? `model=${orchestrator.model}` : "",
    formatList("rules", orchestrator.rules),
    formatList("skills", orchestrator.skills),
    formatList("mcp_servers", orchestrator.mcp_servers),
    formatList("hooks", Object.keys(config.hooks.functions)),
  ]
    .filter(Boolean)
    .join(" ");
}

function formatList(label: string, items: string[] | undefined): string {
  return items?.length ? `${label}=${items.join(",")}` : "";
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}
