import { Option } from "effect";
import { stringify } from "yaml";

import type { PipelineConfig, SchedulingRole } from "../config";
import type { ScheduleArtifact, ScheduleArtifactError, SchedulePlanningContext } from "../planning/generate";

const SCHEDULE_BUILTINS = [
  "drain-merge",
  "duplication",
  "fallow",
  "lint",
  "open-pull-request",
  "semgrep",
  "test",
  "typecheck",
] as const;

export const plannerRepairPrompt = (inputs: {
  attempt: number;
  baseline: ScheduleArtifact;
  error: ScheduleArtifactError;
  source: string;
}): string =>
  [
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

const tokenBudgetPrompt = (config: PipelineConfig): string => {
  const budget = config.token_budget;
  const windows = Object.entries(budget.model_context_windows);
  const fanOut = Object.entries(budget.fan_out_width.by_category);
  return [
    `- Keep each node's assembled context under ${budget.max_context_pct}% of its model's context window; prefer the smallest-tier model whose window comfortably holds the node within that cap.`,
    `- Assume ${budget.default_context_window} tokens of context window for a model with no declared window.`,
    ...(windows.length > 0
      ? [`- Known model context windows: ${windows.map(([id, size]) => `${id}=${size}`).join(", ")}.`]
      : []),
    `- Do not exceed the per-category fan-out width (max concurrent same-category nodes). Default width: ${budget.fan_out_width.default}.`,
    ...(fanOut.length > 0
      ? [`- Category fan-out caps: ${fanOut.map(([category, width]) => `${category}=${width}`).join(", ")}.`]
      : []),
  ].join("\n");
};

const nonEmptyStringOption = (value: string): Option.Option<string> =>
  value.length > 0 ? Option.some(value) : Option.none();

const profileModel = (
  profile: PipelineConfig["profiles"][string],
  runner: Option.Option<PipelineConfig["runners"][string]>,
): Option.Option<string> => {
  if (profile.model !== undefined) {
    return Option.some(profile.model);
  }
  return Option.match(runner, {
    onNone: () => Option.none(),
    onSome: (runnerConfig) => Option.fromUndefinedOr(runnerConfig.model),
  });
};

const profileTools = (profile: PipelineConfig["profiles"][string]): Option.Option<string> => {
  if (profile.tools === undefined) {
    return Option.none();
  }
  return nonEmptyStringOption(profile.tools.join(", "));
};

const profileFilesystemMode = (profile: PipelineConfig["profiles"][string]): Option.Option<string> =>
  Option.fromUndefinedOr(profile.filesystem?.mode);

const profileNetworkMode = (profile: PipelineConfig["profiles"][string]): Option.Option<string> =>
  Option.fromUndefinedOr(profile.network?.mode);

const profileOutputFormat = (profile: PipelineConfig["profiles"][string]): string => profile.output?.format ?? "text";

const requiredProfilePromptField = (label: string, value: string): string => `${label}: ${value}`;

const optionalProfilePromptField = (label: string, value: Option.Option<string>): Option.Option<string> =>
  Option.map(value, (resolved) => requiredProfilePromptField(label, resolved));

const definedProfilePromptFields = (fields: Option.Option<string>[]): string[] =>
  fields.flatMap((field) =>
    Option.match(field, {
      onNone: () => [],
      onSome: (value) => [value],
    }),
  );

const resolveSchedulerCatalog = (config: PipelineConfig, entrypointId: string) => {
  const command = Object.hasOwn(config.scheduler.commands, entrypointId)
    ? config.scheduler.commands[entrypointId]
    : undefined;
  const catalogId = command?.catalog ?? entrypointId;
  if (Object.hasOwn(config.scheduler.node_catalogs, catalogId)) {
    return Option.some(config.scheduler.node_catalogs[catalogId]);
  }
  if (Object.hasOwn(config.scheduler.node_catalogs, entrypointId)) {
    return Option.some(config.scheduler.node_catalogs[entrypointId]);
  }
  return Option.none();
};

const schedulerCatalogPrompt = (config: PipelineConfig, entrypointId: string): string => {
  const catalog = resolveSchedulerCatalog(config, entrypointId);
  return Option.match(catalog, {
    onNone: () => "No scheduler node catalog configured for this entrypoint.",
    onSome: (resolved) =>
      stringify({
        nodes: resolved.nodes,
        required_categories: resolved.required_categories,
      }),
  });
};

const effectiveSchedulingRoles = (config: PipelineConfig, profileId: string): SchedulingRole[] =>
  [...new Set(config.profiles[profileId].scheduling_roles ?? [])].toSorted();

const profilePromptFields = (
  config: PipelineConfig,
  id: string,
  profile: PipelineConfig["profiles"][string],
  runner: Option.Option<PipelineConfig["runners"][string]>,
): string[] =>
  definedProfilePromptFields([
    Option.some(requiredProfilePromptField("runner", profile.runner)),
    optionalProfilePromptField("model", profileModel(profile, runner)),
    optionalProfilePromptField(
      "scheduling_roles",
      nonEmptyStringOption(effectiveSchedulingRoles(config, id).join(", ")),
    ),
    optionalProfilePromptField("description", Option.fromUndefinedOr(profile.description)),
    optionalProfilePromptField("tools", profileTools(profile)),
    optionalProfilePromptField("filesystem", profileFilesystemMode(profile)),
    optionalProfilePromptField("network", profileNetworkMode(profile)),
    Option.some(requiredProfilePromptField("output", profileOutputFormat(profile))),
  ]);

const allowedProfilePromptLine = (config: PipelineConfig, id: string): string => {
  const profile = config.profiles[id];
  const runner = Option.fromUndefinedOr(config.runners[profile.runner]);
  const fields = profilePromptFields(config, id, profile, runner);
  return `- ${id} (${fields.join("; ")})`;
};

export const plannerPrompt = (
  entrypointId: string,
  task: string,
  baseline: ScheduleArtifact,
  config: PipelineConfig,
  planningContext: SchedulePlanningContext,
): string =>
  [
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
    "When a parallel node contains more than one write-capable (implementation/GREEN) child, it MUST be followed by a builtin drain-merge node that needs the parallel node, and the parallel's downstream consumers must depend on that drain-merge. The drain-merge integrates the concurrent children; a parallel of multiple writers without one is rejected.",
    "Use one acceptance or verifier node for multiple GREEN nodes when the same acceptance checklist or real repository commands prove the group.",
    "Only serialize ticket nodes when the backlog, a shared migration/schema/API dependency, or implementation risk requires it.",
    "",
    "Allowed profiles:",
    ...Object.keys(config.profiles)
      .toSorted()
      .map((id) => allowedProfilePromptLine(config, id)),
    "",
    "Scheduler node catalog:",
    schedulerCatalogPrompt(config, entrypointId),
    "",
    "Token budget:",
    tokenBudgetPrompt(config),
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
    "Pre-schedule research context:",
    planningContext.research ? stringify(planningContext.research) : "No pre-schedule research context was recorded.",
    "",
    "Baseline schedule:",
    stringify(baseline),
  ].join("\n");
