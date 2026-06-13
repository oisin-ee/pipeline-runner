import { stringify } from "yaml";
import type { PipelineConfig, SchedulingRole } from "../config";
import type {
  ScheduleArtifact,
  ScheduleArtifactError,
  SchedulePlanningContext,
} from "../planning/generate";

const SCHEDULE_BUILTINS = [
  "drain-merge",
  "duplication",
  "fallow",
  "lint",
  "semgrep",
  "test",
  "typecheck",
] as const;

export function plannerPrompt(
  entrypointId: string,
  task: string,
  baseline: ScheduleArtifact,
  config: PipelineConfig,
  planningContext: SchedulePlanningContext
): string {
  return [
    `Create a pipeline schedule for entrypoint '${entrypointId}'.`,
    "Planner mode: constrained agent graph",
    `Task: ${task}`,
    "Return only YAML matching kind: pipeline-schedule.",
    "Preserve version, kind, schedule_id, source_entrypoint, task, and generated_at. Keep root_workflow: root.",
    "All workflow ids, node ids, gate ids, and needs references must match ^[a-z][a-z0-9-]*$: use lowercase hyphenated ids, never underscores.",
    "Generate exactly one workflow named root. Do not embed default, infra, track, or other configured workflow copies.",
    "Use only explicit generated agent, builtin, command, parallel, or group nodes.",
    "Node schema contract:",
    "- Agent node fields: id, kind: agent, profile, optional models, needs, gates, artifacts, retries, task_context, timeout_ms. Do not emit instructions, skills, tools, filesystem, network, model, or runner on nodes.",
    "- Agent models must be a YAML sequence copied from the configured scheduler node catalog. Do not emit a scalar model field.",
    "- Command node fields: id, kind: command, command, optional needs, gates, artifacts, retries, task_context, timeout_ms. command must be a YAML sequence of strings such as command: [bun, run, test], never a scalar string.",
    "- Builtin node fields: id, kind: builtin, builtin, optional needs, gates, artifacts, retries, task_context, timeout_ms.",
    `- Allowed builtin values: ${SCHEDULE_BUILTINS.join(", ")}. Do not emit dependency or other invented builtin ids.`,
    "- Parallel node fields: id, kind: parallel, nodes, optional needs, gates, artifacts, retries, task_context, timeout_ms. Nested nodes must follow the same schema.",
    "- Group node fields: id, kind: group, nodes, optional needs, gates, artifacts, retries, task_context, timeout_ms. nodes must be a YAML sequence of node ids.",
    "Every agent node must declare one configured profile id. Do not invent profile ids or node-level skill overrides.",
    "Assign each backlog work unit to explicit generated agent nodes with task_context.id. The scheduler hydrates title, description, and acceptance_criteria after parsing.",
    "Do not copy backlog descriptions or acceptance criteria into task_context output.",
    "Profiles with the implementation scheduling role must have downstream profiles with the coverage scheduling role in the generated DAG.",
    "Preserve Backlog dependency ids as schedule needs edges. A node assigned a dependent work unit must depend on the nodes assigned its prerequisite work units, directly or through an explicit path.",
    "Shape the graph by intent, not by ticket count. Do not create a full RED/GREEN/ACCEPTANCE/VERIFY chain for each backlog ticket unless each step needs ticket-specific evidence.",
    "Only add needs edges for real dependencies, shared constraints, or verification/review fan-in.",
    "Use one RED node for a group of tickets when they share a test strategy, then fan out to parallel GREEN implementation nodes where the work can be implemented independently.",
    "Use one acceptance or verifier node for multiple GREEN nodes when the same acceptance checklist or real repository commands prove the group.",
    "Only serialize ticket nodes when the backlog, a shared migration/schema/API dependency, or implementation risk requires it.",
    "",
    "Allowed profiles:",
    ...Object.keys(config.profiles)
      .sort()
      .map((id) => allowedProfilePromptLine(config, id)),
    "",
    "Scheduler node catalog:",
    schedulerCatalogPrompt(config, entrypointId),
    "",
    "Gate recipes:",
    "- Prefer preserving valid gates from the baseline workflows instead of recreating them.",
    "- RED/test coverage may use changed_files gates on test-writing nodes. A changed_files gate must include a changed_files object with allow and/or require_any glob arrays.",
    "- Do not add blocking builtin test, lint, typecheck, or fallow nodes between RED test-writing nodes and GREEN implementation nodes. RED tests are expected to make checks fail until GREEN implementation fixes the behavior.",
    "- Acceptance coverage may use acceptance and verdict gates. Acceptance gates may use target: stdout and required: false.",
    "- Verification may use builtin typecheck, test, lint, fallow, semgrep, duplication, plus verdict gates.",
    "",
    "Backlog work units:",
    planningContext.workUnits.length > 0
      ? stringify(planningContext.workUnits)
      : "No backlog child tickets were resolved; decompose the prompt conservatively.",
    "",
    "Backlog parent context:",
    planningContext.parentWorkUnits.length > 0
      ? stringify(planningContext.parentWorkUnits)
      : "No backlog parent context was resolved.",
    "",
    "Baseline schedule:",
    stringify(baseline),
  ].join("\n");
}

export function plannerRepairPrompt(inputs: {
  attempt: number;
  baseline: ScheduleArtifact;
  error: ScheduleArtifactError;
  source: string;
}): string {
  return [
    "Repair the pipeline schedule YAML so it matches the package schedule schema.",
    `Repair attempt: ${inputs.attempt}`,
    "Return only YAML matching kind: pipeline-schedule. Do not use Markdown fences or prose.",
    "Preserve the task, generated_at, schedule_id, source_entrypoint, version, and root_workflow values.",
    "Generate exactly one workflow named root.",
    "Do not add fields outside the node schema.",
    "Agent nodes must not contain instructions, skills, tools, filesystem, network, model, or runner fields. models is allowed only as a YAML sequence copied from the scheduler node catalog.",
    "Command nodes must use command as a YAML sequence of strings, never as a scalar string.",
    `Builtin nodes and gates may only use: ${SCHEDULE_BUILTINS.join(", ")}.`,
    "Keep valid gates and needs edges when they satisfy the schema.",
    "",
    "Validation error:",
    inputs.error.message,
    "",
    "Original schedule output:",
    inputs.source,
    "",
    "Baseline schedule for required metadata:",
    stringify(inputs.baseline),
  ].join("\n");
}

function allowedProfilePromptLine(config: PipelineConfig, id: string): string {
  const profile = config.profiles[id];
  const runner = config.runners[profile.runner];
  const fields = profilePromptFields(config, id, profile, runner);
  return `- ${id} (${fields.join("; ")})`;
}

function profilePromptFields(
  config: PipelineConfig,
  id: string,
  profile: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string] | undefined
): string[] {
  return definedProfilePromptFields([
    requiredProfilePromptField("runner", profile.runner),
    optionalProfilePromptField("model", profileModel(profile, runner)),
    optionalProfilePromptField(
      "scheduling_roles",
      effectiveSchedulingRoles(config, id).join(", ")
    ),
    optionalProfilePromptField("description", profile.description),
    optionalProfilePromptField("tools", profileTools(profile)),
    optionalProfilePromptField("filesystem", profileFilesystemMode(profile)),
    optionalProfilePromptField("network", profileNetworkMode(profile)),
    requiredProfilePromptField("output", profileOutputFormat(profile)),
  ]);
}

function profileModel(
  profile: PipelineConfig["profiles"][string],
  runner: PipelineConfig["runners"][string] | undefined
): string | undefined {
  return profile.model ?? runner?.model;
}

function profileTools(
  profile: PipelineConfig["profiles"][string]
): string | undefined {
  return profile.tools?.join(", ");
}

function profileFilesystemMode(
  profile: PipelineConfig["profiles"][string]
): string | undefined {
  return profile.filesystem?.mode;
}

function profileNetworkMode(
  profile: PipelineConfig["profiles"][string]
): string | undefined {
  return profile.network?.mode;
}

function profileOutputFormat(
  profile: PipelineConfig["profiles"][string]
): string {
  return profile.output?.format ?? "text";
}

function requiredProfilePromptField(label: string, value: string): string {
  return `${label}: ${value}`;
}

function optionalProfilePromptField(
  label: string,
  value: string | undefined
): string | undefined {
  return value ? requiredProfilePromptField(label, value) : undefined;
}

function definedProfilePromptFields(
  fields: Array<string | undefined>
): string[] {
  return fields.filter((field): field is string => Boolean(field));
}

function schedulerCatalogPrompt(
  config: PipelineConfig,
  entrypointId: string
): string {
  const catalog = resolveSchedulerCatalog(config, entrypointId);
  if (!catalog) {
    return "No scheduler node catalog configured for this entrypoint.";
  }
  return stringify({
    required_categories: catalog.required_categories,
    nodes: catalog.nodes,
  });
}

function resolveSchedulerCatalog(config: PipelineConfig, entrypointId: string) {
  const command = config.scheduler.commands[entrypointId];
  return (
    config.scheduler.node_catalogs[command?.catalog ?? entrypointId] ??
    config.scheduler.node_catalogs[entrypointId]
  );
}

function effectiveSchedulingRoles(
  config: PipelineConfig,
  profileId: string
): SchedulingRole[] {
  return [
    ...new Set(config.profiles[profileId]?.scheduling_roles ?? []),
  ].sort();
}
