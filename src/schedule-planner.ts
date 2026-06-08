import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alg, Graph } from "@dagrejs/graphlib";
import matter from "gray-matter";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  type PipelineConfig,
  type ScheduleBaseline,
  type SchedulingRole,
  validatePipelineConfig,
  workflowSchema,
} from "./config.js";
import {
  type AgentResult,
  createRunnerLaunchPlan,
  type RunnerExecutionOptions,
  type RunnerLaunchPlan,
  runLaunchPlan,
} from "./runner.js";
import { normalizeRunnerOutput } from "./runner-output.js";
import { extractTicketIds } from "./task-ref.js";
import {
  compileWorkflowPlan,
  type WorkflowExecutionPlan,
} from "./workflow-planner.js";

const SCHEDULE_KIND = "pipeline-schedule";
const ID_RE = /^[a-z][a-z0-9-]*$/;
const DESCRIPTION_SECTION_RE = /## Description\s+([\s\S]*?)(?=\n## |\s*$)/;
const ACCEPTANCE_SECTION_RE =
  /## Acceptance Criteria\s+([\s\S]*?)(?=\n## |\s*$)/;
const ACCEPTANCE_ITEM_RE = /^\s*-\s*\[[ xX]\]\s*#?([\w.-]+)\s+(.+)$/;
const GENERATED_ID_INVALID_CHARS_RE = /[^a-z0-9]+/g;
const GENERATED_ID_TRIM_HYPHENS_RE = /^-+|-+$/g;
const STARTS_WITH_ALPHA_RE = /^[a-z]/;
const LINE_RE = /\r?\n/;
const SCHEDULE_PLANNER_REPAIR_ATTEMPTS = 1;
const SCHEDULE_BUILTINS = [
  "drain-merge",
  "duplication",
  "semgrep",
  "test",
  "typecheck",
] as const;
const DEFAULT_GENERATED_COVERAGE_PROFILE_PREFERENCE = [
  "pipeline-verifier",
  "pipeline-acceptance-reviewer",
  "pipeline-thermo-nuclear-reviewer",
];

const scheduleArtifactSchema = z
  .object({
    generated_at: z.string().datetime(),
    kind: z.literal(SCHEDULE_KIND),
    root_workflow: z.string().regex(ID_RE),
    schedule_id: z.string().regex(ID_RE),
    source_entrypoint: z.string().regex(ID_RE),
    task: z.string().min(1),
    version: z.literal(1),
    workflows: z.record(z.string().regex(ID_RE), workflowSchema),
  })
  .strict();

export type ScheduleArtifact = z.infer<typeof scheduleArtifactSchema>;

export interface CompiledScheduleArtifact {
  config: PipelineConfig;
  plan: WorkflowExecutionPlan;
  workflowId: string;
}

export interface GenerateScheduleOptions {
  config: PipelineConfig;
  entrypointId: string;
  executor?: (
    plan: RunnerLaunchPlan,
    options: RunnerExecutionOptions
  ) => AgentResult | Promise<AgentResult>;
  generatedAt?: Date;
  runId?: string;
  task: string;
  worktreePath: string;
}

export interface GenerateScheduleResult {
  artifact: ScheduleArtifact;
  path: string;
}

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

interface BacklogWorkUnit {
  acceptance_criteria: Array<{ id: string; text: string }>;
  dependencies?: string[];
  description?: string;
  id: string;
  title?: string;
}

interface SchedulePlanningContext {
  parentWorkUnits: BacklogWorkUnit[];
  workUnits: BacklogWorkUnit[];
}

export function parseScheduleArtifact(
  source: string,
  sourcePath = "schedule.yaml"
): ScheduleArtifact {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ScheduleArtifactError(
      `Failed to parse ${sourcePath}: ${document.errors.map((err) => err.message).join("; ")}`
    );
  }

  const parsed = scheduleArtifactSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw new ScheduleArtifactError(
      [
        `Invalid schedule artifact ${sourcePath}:`,
        ...parsed.error.issues.map((issue) =>
          issue.path.length > 0
            ? `- ${issue.path.join(".")}: ${issue.message}`
            : `- ${issue.message}`
        ),
      ].join("\n")
    );
  }
  return parsed.data;
}

export class ScheduleArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleArtifactError";
  }
}

export function compileScheduleArtifact(
  config: PipelineConfig,
  artifact: ScheduleArtifact,
  projectRoot?: string
): CompiledScheduleArtifact {
  if (!artifact.workflows[artifact.root_workflow]) {
    throw new ScheduleArtifactError(
      `schedule root workflow '${artifact.root_workflow}' is not declared`
    );
  }

  const workflowIds = Object.keys(artifact.workflows);
  const mappedIds = new Map(
    workflowIds.map((id) => [id, scheduleWorkflowId(artifact.schedule_id, id)])
  );
  const scheduledWorkflows = Object.fromEntries(
    Object.entries(artifact.workflows).map(([id, workflow]) => [
      mappedIds.get(id) ?? id,
      rewriteWorkflowReferences(workflow, mappedIds),
    ])
  );
  const workflowId = mappedIds.get(artifact.root_workflow);
  if (!workflowId) {
    throw new ScheduleArtifactError(
      `schedule root workflow '${artifact.root_workflow}' is not declared`
    );
  }

  const mergedConfig: PipelineConfig = validatePipelineConfig(
    {
      ...structuredClone(config),
      workflows: {
        ...structuredClone(config.workflows),
        ...scheduledWorkflows,
      },
    },
    projectRoot,
    { allowMissingLintFileReferences: true }
  );
  return {
    config: mergedConfig,
    plan: compileWorkflowPlan(mergedConfig, workflowId),
    workflowId,
  };
}

export async function generateScheduleArtifact(
  options: GenerateScheduleOptions
): Promise<GenerateScheduleResult> {
  const entrypoint = options.config.entrypoints[options.entrypointId];
  if (!(entrypoint && "schedule" in entrypoint)) {
    throw new ScheduleArtifactError(
      `entrypoint '${options.entrypointId}' is not a scheduled entrypoint`
    );
  }
  const policy = options.config.schedules[entrypoint.schedule];
  if (!policy) {
    throw new ScheduleArtifactError(
      `schedule policy '${entrypoint.schedule}' is not declared`
    );
  }

  const baseline = baselineScheduleArtifact({
    baseline: policy.baseline,
    config: options.config,
    entrypointId: options.entrypointId,
    generatedAt: options.generatedAt ?? new Date(),
    runId: options.runId,
    task: options.task,
  });
  const planningContext: SchedulePlanningContext = {
    ...loadBacklogPlanningContext(options.task, options.worktreePath),
  };
  const artifact = hydrateScheduleTaskContexts(
    addGeneratedImplementationCoverage(
      options.config,
      await planScheduleArtifact(
        baseline,
        policy.planner_profile,
        options,
        planningContext
      )
    ),
    planningContext
  );
  validateScheduleArtifact(options.config, artifact, planningContext);
  compileScheduleArtifact(options.config, artifact, options.worktreePath);
  return { artifact, path: `memory:${artifact.schedule_id}` };
}

function addGeneratedImplementationCoverage(
  config: PipelineConfig,
  artifact: ScheduleArtifact
): ScheduleArtifact {
  const coverageProfileId = generatedCoverageProfileId(config);
  if (!coverageProfileId) {
    return artifact;
  }
  return {
    ...artifact,
    workflows: Object.fromEntries(
      Object.entries(artifact.workflows).map(([id, workflow]) => [
        id,
        addWorkflowImplementationCoverage(config, workflow, coverageProfileId),
      ])
    ),
  };
}

function addWorkflowImplementationCoverage(
  config: PipelineConfig,
  workflow: Workflow,
  coverageProfileId: string
): Workflow {
  return {
    ...workflow,
    nodes: addNodeScopeImplementationCoverage(
      config,
      workflow.nodes,
      coverageProfileId
    ),
  };
}

function addNodeScopeImplementationCoverage(
  config: PipelineConfig,
  nodes: WorkflowNode[],
  coverageProfileId: string
): WorkflowNode[] {
  const scopedNodes = nodes.map((node) =>
    node.kind === "parallel"
      ? {
          ...node,
          nodes: addNodeScopeImplementationCoverage(
            config,
            node.nodes,
            coverageProfileId
          ),
        }
      : node
  );
  const dependentsByNeed = workflowDependentsByNeed(scopedNodes);
  const uncovered = scopedNodes
    .filter((node) => isImplementationNode(config, node))
    .filter(
      (node) => !hasDownstreamCoverage(config, node.id, dependentsByNeed)
    );
  if (uncovered.length === 0) {
    return scopedNodes;
  }
  const usedIds = new Set(scopedNodes.map((node) => node.id));
  const coverageNodeId = uniqueGeneratedId(
    "generated-coverage",
    usedIds,
    "generated-coverage"
  );
  return [
    ...scopedNodes,
    {
      gates: generatedCoverageGates(coverageNodeId),
      id: coverageNodeId,
      kind: "agent",
      needs: uncovered.map((node) => node.id),
      profile: coverageProfileId,
    },
  ];
}

function generatedCoverageProfileId(config: PipelineConfig): string | null {
  const coverageProfiles = Object.entries(config.profiles)
    .filter(([, profile]) => profile.scheduling_roles?.includes("coverage"))
    .map(([id]) => id);
  if (coverageProfiles.length === 0) {
    return null;
  }
  return (
    DEFAULT_GENERATED_COVERAGE_PROFILE_PREFERENCE.find((id) =>
      coverageProfiles.includes(id)
    ) ??
    coverageProfiles.sort()[0] ??
    null
  );
}

function generatedCoverageGates(
  nodeId: string
): NonNullable<WorkflowNode["gates"]> {
  return [
    { builtin: "typecheck", id: `${nodeId}-typecheck`, kind: "builtin" },
    { builtin: "test", id: `${nodeId}-tests`, kind: "builtin" },
    { builtin: "semgrep", id: `${nodeId}-semgrep`, kind: "builtin" },
    {
      builtin: "duplication",
      id: `${nodeId}-duplication`,
      kind: "builtin",
    },
    { id: `${nodeId}-verdict`, kind: "verdict", target: "stdout" },
  ];
}

export function scheduleArtifactPath(
  worktreePath: string,
  scheduleId: string
): string {
  return join(worktreePath, ".pipeline", "runs", scheduleId, "schedule.yaml");
}

function scheduleWorkflowId(scheduleId: string, workflowId: string): string {
  return `schedule-${scheduleId}-${workflowId}`;
}

function rewriteWorkflowReferences(
  workflow: Workflow,
  mappedIds: Map<string, string>
): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => rewriteNodeReferences(node, mappedIds)),
  };
}

function rewriteNodeReferences(
  node: WorkflowNode,
  mappedIds: Map<string, string>
): WorkflowNode {
  if (node.kind === "workflow") {
    const workflow = mappedIds.get(node.workflow);
    if (!workflow) {
      throw new ScheduleArtifactError(
        `schedule workflow node '${node.id}' references external workflow '${node.workflow}'`
      );
    }
    return { ...node, workflow };
  }
  if (node.kind === "parallel") {
    return {
      ...node,
      nodes: node.nodes.map((child) => rewriteNodeReferences(child, mappedIds)),
    };
  }
  return node;
}

function baselineScheduleArtifact(input: {
  baseline: ScheduleBaseline;
  config: PipelineConfig;
  entrypointId: string;
  generatedAt: Date;
  runId?: string;
  task: string;
}): ScheduleArtifact {
  const scheduleId = input.runId ?? defaultScheduleId(input.generatedAt);
  const baseline = baselineWorkflows(input.baseline, input.config);
  return {
    generated_at: input.generatedAt.toISOString(),
    kind: SCHEDULE_KIND,
    root_workflow: baseline.rootWorkflow,
    schedule_id: scheduleId,
    source_entrypoint: input.entrypointId,
    task: input.task,
    version: 1,
    workflows: baseline.workflows,
  };
}

function baselineWorkflows(
  baseline: ScheduleBaseline,
  config: PipelineConfig
): { rootWorkflow: string; workflows: ScheduleArtifact["workflows"] } {
  if (baseline === "pipe") {
    const workflow = config.workflows.default;
    return workflow
      ? {
          rootWorkflow: "root",
          workflows: configuredWorkflowClosureWithRootAlias(config, "default"),
        }
      : { rootWorkflow: "root", workflows: pipeBaselineWorkflow() };
  }

  return { rootWorkflow: "root", workflows: epicBaselineWorkflow() };
}

function configuredWorkflowClosure(
  config: PipelineConfig,
  rootWorkflowId: string
): ScheduleArtifact["workflows"] {
  const workflows: ScheduleArtifact["workflows"] = {};
  const queue = [rootWorkflowId];
  while (queue.length > 0) {
    const workflowId = queue.shift();
    if (!workflowId || workflows[workflowId]) {
      continue;
    }
    const workflow = config.workflows[workflowId];
    if (!workflow) {
      continue;
    }
    workflows[workflowId] = structuredClone(workflow);
    for (const node of allWorkflowNodes({ [workflowId]: workflow })) {
      if (node.kind === "workflow") {
        queue.push(node.workflow);
      }
    }
  }
  return workflows;
}

function configuredWorkflowClosureWithRootAlias(
  config: PipelineConfig,
  rootWorkflowId: string
): ScheduleArtifact["workflows"] {
  const workflows = configuredWorkflowClosure(config, rootWorkflowId);
  const rootWorkflow = workflows[rootWorkflowId];
  if (!rootWorkflow) {
    return workflows;
  }
  const { [rootWorkflowId]: _, ...embeddedWorkflows } = workflows;
  return { root: rootWorkflow, ...embeddedWorkflows };
}

function pipeBaselineWorkflow(): ScheduleArtifact["workflows"] {
  return {
    root: {
      description: "Generated pipe schedule.",
      nodes: [
        { id: "research", kind: "agent", profile: "pipeline-researcher" },
        {
          id: "implement",
          kind: "agent",
          needs: ["research"],
          profile: "pipeline-code-writer",
        },
        {
          gates: [
            { builtin: "typecheck", id: "verify-typecheck", kind: "builtin" },
            { builtin: "test", id: "verify-tests", kind: "builtin" },
            { kind: "verdict", id: "verify-verdict", target: "stdout" },
          ],
          id: "verify",
          kind: "agent",
          needs: ["implement"],
          profile: "pipeline-verifier",
        },
        {
          id: "learn",
          kind: "agent",
          needs: ["verify"],
          profile: "pipeline-learner",
        },
      ],
    },
  };
}

function epicBaselineWorkflow(): ScheduleArtifact["workflows"] {
  return {
    root: {
      description: "Generated explicit epic schedule seed.",
      nodes: [
        { id: "research", kind: "agent", profile: "pipeline-researcher" },
        {
          id: "plan",
          kind: "agent",
          needs: ["research"],
          profile: "pipeline-epic-router",
        },
        {
          gates: [
            {
              changed_files: {
                allow: [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                  "**/*.snap",
                ],
                require_any: [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                ],
              },
              id: "red-test-file-policy",
              kind: "changed_files",
            },
          ],
          id: "example-ticket-red",
          kind: "agent",
          needs: ["plan"],
          profile: "pipeline-test-writer",
        },
        {
          id: "example-ticket-green",
          kind: "agent",
          needs: ["example-ticket-red"],
          profile: "pipeline-code-writer",
        },
        {
          gates: [
            {
              id: "acceptance-coverage",
              kind: "acceptance",
              required: false,
              target: "stdout",
            },
            { id: "acceptance-verdict", kind: "verdict", target: "stdout" },
          ],
          id: "example-ticket-acceptance",
          kind: "agent",
          needs: ["example-ticket-green"],
          profile: "pipeline-acceptance-reviewer",
        },
        {
          gates: [
            { builtin: "typecheck", id: "verify-typecheck", kind: "builtin" },
            { builtin: "test", id: "verify-tests", kind: "builtin" },
            { builtin: "semgrep", id: "verify-semgrep", kind: "builtin" },
            {
              builtin: "duplication",
              id: "verify-duplication",
              kind: "builtin",
            },
            { id: "verify-verdict", kind: "verdict", target: "stdout" },
          ],
          id: "example-ticket-verify",
          kind: "agent",
          needs: ["example-ticket-acceptance"],
          profile: "pipeline-verifier",
        },
        {
          builtin: "drain-merge",
          id: "merge",
          kind: "builtin",
          needs: ["example-ticket-verify"],
        },
        {
          gates: [{ id: "review-verdict", kind: "verdict", target: "stdout" }],
          id: "review",
          kind: "agent",
          needs: ["merge"],
          profile: "pipeline-thermo-nuclear-reviewer",
        },
      ],
    },
  };
}

async function planScheduleArtifact(
  baseline: ScheduleArtifact,
  plannerProfile: string | undefined,
  options: GenerateScheduleOptions,
  planningContext: SchedulePlanningContext
): Promise<ScheduleArtifact> {
  if (!plannerProfile) {
    throw new ScheduleArtifactError(
      `schedule '${options.entrypointId}' requires planner_profile`
    );
  }
  const prompt = plannerPrompt(
    options.entrypointId,
    options.task,
    baseline,
    options.config,
    planningContext
  );
  const source = await runSchedulePlanner(plannerProfile, prompt, options);
  if (!source) {
    throw new ScheduleArtifactError("schedule planner returned empty output");
  }

  const initial = acceptedGeneratedSchedule(
    parseGeneratedSchedule(source, "planner output")
  );
  if (initial.ok) {
    return initial.artifact;
  }

  let latestFailure = initial.error;
  let latestSource = source;
  for (
    let attempt = 1;
    attempt <= SCHEDULE_PLANNER_REPAIR_ATTEMPTS;
    attempt += 1
  ) {
    const repairedSource = await runSchedulePlanner(
      plannerProfile,
      plannerRepairPrompt({
        attempt,
        baseline,
        error: latestFailure,
        source: latestSource,
      }),
      options,
      "schedule-plan-repair"
    );
    if (!repairedSource) {
      throw new ScheduleArtifactError(
        `schedule planner repair returned empty output after invalid schedule\n${latestFailure.message}\nPlanner output:\n${latestSource}`
      );
    }
    const repaired = acceptedGeneratedSchedule(
      parseGeneratedSchedule(repairedSource, "planner repair output")
    );
    if (repaired.ok) {
      return repaired.artifact;
    }
    latestFailure = repaired.error;
    latestSource = repairedSource;
  }

  throw new ScheduleArtifactError(
    [
      "Schedule planner produced invalid output after repair.",
      initial.error.message,
      "Original planner output:",
      source,
      latestFailure.message,
      "Planner repair output:",
      latestSource,
    ].join("\n")
  );
}

function parseGeneratedSchedule(
  source: string,
  sourcePath: string
):
  | { artifact: ScheduleArtifact; ok: true }
  | { error: ScheduleArtifactError; ok: false } {
  try {
    return {
      artifact: canonicalizeGeneratedScheduleIds(
        parseScheduleArtifact(source, sourcePath)
      ),
      ok: true,
    };
  } catch (err) {
    if (!(err instanceof ScheduleArtifactError)) {
      throw err;
    }
    return {
      error: new ScheduleArtifactError(
        `${err.message}\nPlanner output:\n${source}`
      ),
      ok: false,
    };
  }
}

function acceptedGeneratedSchedule(
  parsed:
    | { artifact: ScheduleArtifact; ok: true }
    | { error: ScheduleArtifactError; ok: false }
):
  | { artifact: ScheduleArtifact; ok: true }
  | { error: ScheduleArtifactError; ok: false } {
  if (!parsed.ok) {
    return parsed;
  }
  const builtinCheck = generatedBuiltinsSupported(parsed.artifact);
  return builtinCheck.ok ? parsed : builtinCheck;
}

function generatedBuiltinsSupported(
  artifact: ScheduleArtifact
): { ok: true } | { error: ScheduleArtifactError; ok: false } {
  const issues = unsupportedGeneratedBuiltinIssues(artifact);
  return issues.length === 0
    ? { ok: true }
    : {
        error: new ScheduleArtifactError(
          [
            "Invalid generated schedule:",
            ...issues.map((issue) => `- ${issue}`),
          ].join("\n")
        ),
        ok: false,
      };
}

async function runSchedulePlanner(
  plannerProfile: string,
  prompt: string,
  options: GenerateScheduleOptions,
  nodeId = "schedule-plan"
): Promise<string> {
  const executor = options.executor ?? runLaunchPlan;
  const plan = createRunnerLaunchPlan(options.config, {
    nodeId,
    profileId: plannerProfile,
    prompt,
    worktreePath: options.worktreePath,
  });
  const result = await executor(plan, {});
  if (result.exitCode !== 0) {
    throw new ScheduleArtifactError(
      plannerFailureMessage(plannerProfile, result)
    );
  }
  return normalizeRunnerOutput(plan, result.stdout).output.trim();
}

function plannerFailureMessage(
  plannerProfile: string,
  result: { exitCode: number; stderr?: string; stdout: string }
): string {
  const details = [
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const message = `schedule planner '${plannerProfile}' failed with exit ${result.exitCode}`;
  return details.length === 0 ? message : `${message}\n${details.join("\n")}`;
}

function plannerPrompt(
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
    "Generate exactly one workflow named root. Do not embed default, epic-drain, infra, track, or other configured workflow copies.",
    "Use only explicit generated agent, builtin, command, parallel, or group nodes. Do not use kind: workflow.",
    "Node schema contract:",
    "- Agent node fields: id, kind: agent, profile, optional needs, gates, artifacts, retries, task_context, timeout_ms. Do not emit instructions, skills, tools, filesystem, network, model, or runner on nodes.",
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
    "Gate recipes:",
    "- Prefer preserving valid gates from the baseline workflows instead of recreating them.",
    "- RED/test coverage may use changed_files gates on test-writing nodes. A changed_files gate must include a changed_files object with allow and/or require_any glob arrays.",
    "- Acceptance coverage may use acceptance and verdict gates. Acceptance gates may use target: stdout and required: false.",
    "- Verification may use builtin typecheck, test, semgrep, duplication, plus verdict gates.",
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

function plannerRepairPrompt(inputs: {
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
    "Do not add fields outside the workflow node schema.",
    "Agent nodes must not contain instructions, skills, tools, filesystem, network, model, or runner fields. Keep intent in task_context.id and the selected configured profile only.",
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
  const roles = effectiveSchedulingRoles(config, id);
  const model = profile.model ?? runner?.model;
  const fields = [
    `runner: ${profile.runner}`,
    model ? `model: ${model}` : "",
    roles.length > 0 ? `scheduling_roles: ${roles.join(", ")}` : "",
    profile.description ? `description: ${profile.description}` : "",
    profile.tools?.length ? `tools: ${profile.tools.join(", ")}` : "",
    profile.filesystem?.mode ? `filesystem: ${profile.filesystem.mode}` : "",
    profile.network?.mode ? `network: ${profile.network.mode}` : "",
    `output: ${profile.output?.format ?? "text"}`,
  ].filter(Boolean);
  return `- ${id} (${fields.join("; ")})`;
}

function effectiveSchedulingRoles(
  config: PipelineConfig,
  profileId: string
): SchedulingRole[] {
  return [
    ...new Set(config.profiles[profileId]?.scheduling_roles ?? []),
  ].sort();
}

function canonicalizeGeneratedScheduleIds(
  artifact: ScheduleArtifact
): ScheduleArtifact {
  return {
    ...artifact,
    workflows: Object.fromEntries(
      Object.entries(artifact.workflows).map(([workflowId, workflow]) => [
        workflowId,
        canonicalizeWorkflowNodeIds(workflow),
      ])
    ),
  };
}

function canonicalizeWorkflowNodeIds(workflow: Workflow): Workflow {
  const nodeIdMap = new Map<string, string>();
  const usedNodeIds = new Set<string>();
  for (const node of workflow.nodes.flatMap(flattenWorkflowNode)) {
    nodeIdMap.set(node.id, uniqueGeneratedId(node.id, usedNodeIds, "node"));
  }
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      rewriteGeneratedWorkflowNodeIds(node, nodeIdMap)
    ),
  };
}

function rewriteGeneratedWorkflowNodeIds(
  node: WorkflowNode,
  nodeIdMap: Map<string, string>
): WorkflowNode {
  const rewritten = {
    ...node,
    id: nodeIdMap.get(node.id) ?? node.id,
    ...(node.needs
      ? { needs: node.needs.map((need) => nodeIdMap.get(need) ?? need) }
      : {}),
  };
  return rewritten.kind === "parallel"
    ? {
        ...rewritten,
        nodes: rewritten.nodes.map((child) =>
          rewriteGeneratedWorkflowNodeIds(child, nodeIdMap)
        ),
      }
    : rewritten;
}

function uniqueGeneratedId(
  value: string,
  usedIds: Set<string>,
  fallbackPrefix: string
): string {
  const base = generatedId(value, fallbackPrefix);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function generatedId(value: string, fallbackPrefix: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(GENERATED_ID_INVALID_CHARS_RE, "-")
    .replaceAll(GENERATED_ID_TRIM_HYPHENS_RE, "");
  if (STARTS_WITH_ALPHA_RE.test(slug)) {
    return slug;
  }
  return slug ? `${fallbackPrefix}-${slug}` : fallbackPrefix;
}

function validateScheduleArtifact(
  config: PipelineConfig,
  artifact: ScheduleArtifact,
  planningContext: SchedulePlanningContext
): void {
  const issues = [
    ...generatedRootWorkflowIssues(artifact),
    ...workflowReferenceNodeIssues(artifact),
    ...workflowAssignedWorkUnitIssues(artifact, planningContext.workUnits),
    ...missingAssignedWorkUnitIssues(artifact, planningContext.workUnits),
    ...workUnitDependencyIssues(config, artifact, planningContext.workUnits),
    ...invalidWorkflowPrimitiveIssues(config, artifact),
    ...unsupportedGeneratedBuiltinIssues(artifact),
    ...implementationCoverageIssues(config, artifact),
  ];
  if (issues.length > 0) {
    throw new ScheduleArtifactError(
      [
        "Invalid generated schedule:",
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n")
    );
  }
}

function generatedRootWorkflowIssues(artifact: ScheduleArtifact): string[] {
  const workflowIds = Object.keys(artifact.workflows);
  const issues: string[] = [];
  if (artifact.root_workflow !== "root") {
    issues.push("generated schedules must use root_workflow 'root'");
  }
  if (workflowIds.length !== 1 || !artifact.workflows.root) {
    issues.push(
      "generated schedules must embed exactly one task-specific workflow named 'root'"
    );
  }
  return issues;
}

function workflowReferenceNodeIssues(artifact: ScheduleArtifact): string[] {
  const workflowNodes = allWorkflowNodes(artifact.workflows).filter(
    (node) => node.kind === "workflow"
  );
  return workflowNodes.length > 0
    ? [
        `generated schedules must use explicit agent/builtin nodes, not workflow-reference nodes: ${workflowNodes.map((node) => node.id).join(", ")}`,
      ]
    : [];
}

function workflowAssignedWorkUnitIssues(
  artifact: ScheduleArtifact,
  workUnits: BacklogWorkUnit[]
): string[] {
  if (workUnits.length === 0) {
    return [];
  }
  const workUnitIds = new Set(workUnits.map((unit) => unit.id));
  const workflowAssignments = allWorkflowNodes(artifact.workflows)
    .filter((node) => node.kind === "workflow")
    .filter((node) => {
      const id = node.task_context?.id;
      return id ? workUnitIds.has(id) : false;
    });
  return workflowAssignments.length > 0
    ? [
        `backlog work unit assignments must use explicit generated agent nodes, not workflow-reference nodes: ${workflowAssignments.map((node) => node.id).join(", ")}`,
      ]
    : [];
}

function hydrateScheduleTaskContexts(
  artifact: ScheduleArtifact,
  planningContext: SchedulePlanningContext
): ScheduleArtifact {
  const contexts = new Map(
    [...planningContext.parentWorkUnits, ...planningContext.workUnits].map(
      (unit) => [unit.id, backlogWorkUnitTaskContext(unit)]
    )
  );
  if (contexts.size === 0) {
    return artifact;
  }
  return {
    ...artifact,
    workflows: Object.fromEntries(
      Object.entries(artifact.workflows).map(([id, workflow]) => [
        id,
        {
          ...workflow,
          nodes: workflow.nodes.map((node) =>
            hydrateWorkflowNodeTaskContext(node, contexts)
          ),
        },
      ])
    ),
  };
}

function backlogWorkUnitTaskContext(
  unit: BacklogWorkUnit
): NonNullable<WorkflowNode["task_context"]> {
  return {
    ...(unit.acceptance_criteria.length > 0
      ? { acceptance_criteria: unit.acceptance_criteria }
      : {}),
    ...(unit.description ? { description: unit.description } : {}),
    id: unit.id,
    ...(unit.title ? { title: unit.title } : {}),
  };
}

function hydrateWorkflowNodeTaskContext(
  node: WorkflowNode,
  contexts: Map<string, NonNullable<WorkflowNode["task_context"]>>
): WorkflowNode {
  const context = node.task_context?.id
    ? contexts.get(node.task_context.id)
    : undefined;
  const hydrated = context ? { ...node, task_context: context } : node;
  if (hydrated.kind !== "parallel") {
    return hydrated;
  }
  return {
    ...hydrated,
    nodes: hydrated.nodes.map((child) =>
      hydrateWorkflowNodeTaskContext(child, contexts)
    ),
  };
}

function missingAssignedWorkUnitIssues(
  artifact: ScheduleArtifact,
  workUnits: BacklogWorkUnit[]
): string[] {
  if (workUnits.length === 0) {
    return [];
  }
  const assigned = new Set(
    allWorkflowNodes(artifact.workflows)
      .map((node) => node.task_context?.id)
      .filter((id): id is string => Boolean(id))
  );
  const missing = workUnits
    .map((unit) => unit.id)
    .filter((id) => !assigned.has(id));
  return missing.length > 0
    ? [`missing assigned backlog work units: ${missing.join(", ")}`]
    : [];
}

function workUnitDependencyIssues(
  config: PipelineConfig,
  artifact: ScheduleArtifact,
  workUnits: BacklogWorkUnit[]
): string[] {
  if (workUnits.length === 0) {
    return [];
  }
  const workUnitIds = new Set(workUnits.map((unit) => unit.id));
  const dependenciesByUnit = new Map(
    workUnits.map((unit) => [
      unit.id,
      (unit.dependencies ?? []).filter((id) => workUnitIds.has(id)),
    ])
  );
  return Object.entries(artifact.workflows).flatMap(
    ([workflowId, workflow]) => {
      const nodes = workflow.nodes.flatMap(flattenWorkflowNode);
      const dependentsByNeed = workflowDependentsByNeed(nodes);
      const nodesByWorkUnit = nodesByAssignedWorkUnit(nodes);
      return nodes
        .filter((node) => isImplementationNode(config, node))
        .flatMap((node) => {
          const dependentId = node.task_context?.id;
          if (!dependentId) {
            return [];
          }
          return (dependenciesByUnit.get(dependentId) ?? []).flatMap(
            (prerequisiteId) => {
              const prerequisiteNodes =
                nodesByWorkUnit.get(prerequisiteId) ?? [];
              const hasDependencyPath = prerequisiteNodes.some((source) =>
                hasPathToNode(source.id, node.id, dependentsByNeed)
              );
              return hasDependencyPath
                ? []
                : [
                    `work unit dependency edge missing in '${workflowId}': '${dependentId}' node '${node.id}' must depend on prerequisite '${prerequisiteId}' nodes ${prerequisiteNodes.map((prerequisite) => `'${prerequisite.id}'`).join(", ")}`,
                  ];
            }
          );
        });
    }
  );
}

function nodesByAssignedWorkUnit(
  nodes: WorkflowNode[]
): Map<string, WorkflowNode[]> {
  const grouped = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    const id = node.task_context?.id;
    if (!id) {
      continue;
    }
    const current = grouped.get(id) ?? [];
    current.push(node);
    grouped.set(id, current);
  }
  return grouped;
}

function hasPathToNode(
  sourceId: string,
  targetId: string,
  dependentsByNeed: Map<string, WorkflowNode[]>
): boolean {
  const queue = [...(dependentsByNeed.get(sourceId) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node.id)) {
      continue;
    }
    if (node.id === targetId) {
      return true;
    }
    seen.add(node.id);
    queue.push(...(dependentsByNeed.get(node.id) ?? []));
  }
  return false;
}

function invalidWorkflowPrimitiveIssues(
  config: PipelineConfig,
  artifact: ScheduleArtifact
): string[] {
  const allowed = new Set(Object.keys(config.workflows));
  return allWorkflowNodes(artifact.workflows).flatMap((node) => {
    if (node.kind !== "workflow") {
      return [];
    }
    if (!artifact.workflows[node.workflow]) {
      return [
        `workflow node '${node.id}' references workflow '${node.workflow}' that is not embedded in the schedule artifact`,
      ];
    }
    if (!allowed.has(node.workflow)) {
      return [
        `workflow node '${node.id}' references workflow '${node.workflow}' that is not declared in config`,
      ];
    }
    return [];
  });
}

function unsupportedGeneratedBuiltinIssues(
  artifact: ScheduleArtifact
): string[] {
  const allowed = new Set<string>(SCHEDULE_BUILTINS);
  return allWorkflowNodes(artifact.workflows).flatMap((node) => {
    const nodeBuiltinIssues =
      node.kind === "builtin" && !allowed.has(node.builtin)
        ? [
            `unsupported generated builtin '${node.builtin}' on node '${node.id}'. Allowed builtins: ${SCHEDULE_BUILTINS.join(", ")}`,
          ]
        : [];
    const gateBuiltinIssues = (node.gates ?? []).flatMap((gate) =>
      gate.kind === "builtin" && !allowed.has(gate.builtin)
        ? [
            `unsupported generated builtin gate '${gate.builtin}' on node '${node.id}' gate '${gate.id}'. Allowed builtins: ${SCHEDULE_BUILTINS.join(", ")}`,
          ]
        : []
    );
    return [...nodeBuiltinIssues, ...gateBuiltinIssues];
  });
}

function implementationCoverageIssues(
  config: PipelineConfig,
  artifact: ScheduleArtifact
): string[] {
  return Object.entries(artifact.workflows).flatMap(
    ([workflowId, workflow]) => {
      const nodes = workflow.nodes.flatMap(flattenWorkflowNode);
      const dependentsByNeed = workflowDependentsByNeed(nodes);
      return nodes
        .filter((node) => isImplementationNode(config, node))
        .filter(
          (node) => !hasDownstreamCoverage(config, node.id, dependentsByNeed)
        )
        .map(
          (node) =>
            `implementation node '${workflowId}.${node.id}' is without downstream verification or review`
        );
    }
  );
}

function isImplementationNode(
  config: PipelineConfig,
  node: WorkflowNode
): boolean {
  return hasSchedulingRole(config, node, "implementation");
}

function workflowDependentsByNeed(
  nodes: WorkflowNode[]
): Map<string, WorkflowNode[]> {
  const dependentsByNeed = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      const dependents = dependentsByNeed.get(need) ?? [];
      dependents.push(node);
      dependentsByNeed.set(need, dependents);
    }
  }
  return dependentsByNeed;
}

function hasDownstreamCoverage(
  config: PipelineConfig,
  nodeId: string,
  dependentsByNeed: Map<string, WorkflowNode[]>
): boolean {
  const queue = [...(dependentsByNeed.get(nodeId) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    if (isCoverageNode(config, node)) {
      return true;
    }
    queue.push(...(dependentsByNeed.get(node.id) ?? []));
  }
  return false;
}

function isCoverageNode(config: PipelineConfig, node: WorkflowNode): boolean {
  return hasSchedulingRole(config, node, "coverage");
}

function hasSchedulingRole(
  config: PipelineConfig,
  node: WorkflowNode,
  role: SchedulingRole
): boolean {
  if (node.kind !== "agent") {
    return false;
  }
  const profile = config.profiles[node.profile];
  return profile?.scheduling_roles?.includes(role) ?? false;
}

function allWorkflowNodes(
  workflows: ScheduleArtifact["workflows"]
): WorkflowNode[] {
  return Object.values(workflows).flatMap((workflow) =>
    workflow.nodes.flatMap(flattenWorkflowNode)
  );
}

function flattenWorkflowNode(node: WorkflowNode): WorkflowNode[] {
  return node.kind === "parallel"
    ? [node, ...node.nodes.flatMap(flattenWorkflowNode)]
    : [node];
}

function loadBacklogPlanningContext(
  task: string,
  worktreePath: string
): SchedulePlanningContext {
  const ticketIds = extractTicketIds(task);
  if (ticketIds.length === 0) {
    return { parentWorkUnits: [], workUnits: [] };
  }
  const tasks = readBacklogTasks(worktreePath);
  const tasksById = new Map(tasks.map((taskFile) => [taskFile.id, taskFile]));
  const taskGraph = backlogTaskGraph(tasks);
  const parentWorkUnits: BacklogWorkUnit[] = [];
  const workUnits: BacklogWorkUnit[] = [];
  const parentIds = new Set<string>();
  const workUnitIds = new Set<string>();

  for (const ticketId of ticketIds) {
    const taskFile = tasksById.get(ticketId);
    if (!taskFile) {
      continue;
    }
    const descendants = descendantBacklogTasks(ticketId, taskGraph);
    if (descendants.length === 0) {
      addUniqueWorkUnit(taskFile.workUnit, workUnits, workUnitIds);
      continue;
    }
    addUniqueWorkUnit(taskFile.workUnit, parentWorkUnits, parentIds);
    for (const descendant of descendants) {
      addUniqueWorkUnit(descendant.workUnit, workUnits, workUnitIds);
    }
  }

  return {
    parentWorkUnits,
    workUnits,
  };
}

function backlogTaskGraph(
  tasks: BacklogTaskFile[]
): Graph<undefined, BacklogTaskFile> {
  const graph = new Graph<undefined, BacklogTaskFile>();
  const sortedTasks = [...tasks].sort(compareBacklogTaskIds);
  for (const task of sortedTasks) {
    graph.setNode(task.id, task);
  }
  for (const task of sortedTasks) {
    if (task.parentTaskId && graph.hasNode(task.parentTaskId)) {
      graph.setEdge(task.parentTaskId, task.id);
    }
  }
  return graph;
}

function descendantBacklogTasks(
  taskId: string,
  taskGraph: Graph<undefined, BacklogTaskFile>
): BacklogTaskFile[] {
  if (!taskGraph.hasNode(taskId)) {
    return [];
  }
  return alg
    .preorder(taskGraph, taskId)
    .slice(1)
    .map((id) => taskGraph.node(id))
    .filter((task): task is BacklogTaskFile => Boolean(task));
}

function compareBacklogTaskIds(a: BacklogTaskFile, b: BacklogTaskFile): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function addUniqueWorkUnit(
  workUnit: BacklogWorkUnit,
  target: BacklogWorkUnit[],
  seen: Set<string>
): void {
  if (seen.has(workUnit.id)) {
    return;
  }
  seen.add(workUnit.id);
  target.push(workUnit);
}

interface BacklogTaskFile {
  id: string;
  parentTaskId?: string;
  workUnit: BacklogWorkUnit;
}

function readBacklogTasks(worktreePath: string): BacklogTaskFile[] {
  const tasksDir = join(worktreePath, "backlog", "tasks");
  if (!existsSync(tasksDir)) {
    return [];
  }
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .flatMap((entry) => readBacklogTaskFile(join(tasksDir, entry.name)));
}

function readBacklogTaskFile(path: string): BacklogTaskFile[] {
  const parsed = matter(readFileSync(path, "utf8"));
  const id = stringFrontmatter(parsed.data.id);
  if (!id) {
    return [];
  }
  return [
    {
      id,
      parentTaskId: stringFrontmatter(parsed.data.parent_task_id),
      workUnit: {
        acceptance_criteria: acceptanceCriteriaFromMarkdown(parsed.content),
        ...optionalStringArrayField(
          "dependencies",
          stringArrayFrontmatter(parsed.data.dependencies)
        ),
        ...optionalStringField(
          "description",
          descriptionFromMarkdown(parsed.content)
        ),
        id,
        ...optionalStringField("title", stringFrontmatter(parsed.data.title)),
      },
    },
  ];
}

function stringFrontmatter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayFrontmatter(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalStringField<TKey extends string>(
  key: TKey,
  value: string | undefined
): Record<TKey, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<TKey, string>) : {};
}

function optionalStringArrayField<TKey extends string>(
  key: TKey,
  value: string[]
): Record<TKey, string[]> | Record<string, never> {
  return value.length > 0 ? ({ [key]: value } as Record<TKey, string[]>) : {};
}

function descriptionFromMarkdown(content: string): string | undefined {
  const marked = betweenMarkers(
    content,
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    "<!-- SECTION:DESCRIPTION:END -->"
  );
  if (marked) {
    return marked;
  }
  const match = content.match(DESCRIPTION_SECTION_RE);
  return cleanupMarkdownSection(match?.[1]);
}

function acceptanceCriteriaFromMarkdown(
  content: string
): Array<{ id: string; text: string }> {
  const marked =
    betweenMarkers(content, "<!-- AC:BEGIN -->", "<!-- AC:END -->") ??
    content.match(ACCEPTANCE_SECTION_RE)?.[1] ??
    "";
  return marked
    .split(LINE_RE)
    .map((line) => line.match(ACCEPTANCE_ITEM_RE))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      id: match[1] ?? "",
      text: (match[2] ?? "").trim(),
    }))
    .filter((criterion) => criterion.id && criterion.text);
}

function betweenMarkers(
  content: string,
  start: string,
  end: string
): string | undefined {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return;
  }
  return cleanupMarkdownSection(
    content.slice(startIndex + start.length, endIndex)
  );
}

function cleanupMarkdownSection(value: string | undefined): string | undefined {
  const cleaned = value
    ?.split(LINE_RE)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return cleaned || undefined;
}

function defaultScheduleId(date: Date): string {
  return `run-${date
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
}
