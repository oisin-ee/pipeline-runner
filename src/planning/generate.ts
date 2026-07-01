import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Data } from "effect";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  type PipelineConfig,
  type SchedulingRole,
  validatePipelineConfig,
  workflowSchema,
} from "../config";
import { ensurePipelineWorkspaceIgnore } from "../run-control/workspace";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import { createRunnerLaunchPlan } from "../runner";
import { runLaunchPlan } from "../runner/subprocess";
import { normalizeRunnerOutput } from "../runner-output";
import { loadBacklogPlanningContext } from "../schedule/backlog-context";
import { baselineScheduleArtifact } from "../schedule/baseline";
import { addGeneratedImplementationCoverage } from "../schedule/passes/coverage";
import { integrateParallelWriteFanout } from "../schedule/passes/drain-merge";
import { canonicalizeGeneratedScheduleIds } from "../schedule/passes/ids";
import { SCHEDULE_PASS_ORDER } from "../schedule/passes/index";
import { applyNodeCatalogModelFallbacks } from "../schedule/passes/models";
import { appendPullRequestDelivery } from "../schedule/passes/open-pull-request";
import { namespaceScheduleWorkflows } from "../schedule/passes/references";
import { plannerPrompt, plannerRepairPrompt } from "../schedule/prompts";
import {
  isCoverageNode,
  isImplementationNode,
  isWriteCapableParallelChild,
} from "../schedule/scheduling-roles";
import { uniqueGeneratedId } from "../strings";
import type { TicketPlan } from "../tickets/ticket-plan";
import { compileWorkflowPlan, type WorkflowExecutionPlan } from "./compile";
import { dependentsByNeed, flattenNodes, hasReachableDependent } from "./graph";

const SCHEDULE_KIND = "pipeline-schedule";
const ID_RE = /^[a-z][a-z0-9-]*$/;
const SCHEDULE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MARKDOWN_YAML_FENCE_RE = /```(?:ya?ml)?\s*\r?\n([\s\S]*?)\r?\n```/i;
const SCHEDULE_PLANNER_REPAIR_ATTEMPTS = 1;
const PREFERRED_IMPLEMENTATION_PROFILE_IDS = ["moka-code-writer"] as const;
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
// Builtins that consume a parallel's write-capable children and resolve them to
// a single result, satisfying the worktree-isolation requirement: drain-merge
// integrates the children.
const PARALLEL_MERGE_BUILTINS = new Set(["drain-merge"]);
const scheduleArtifactSchema = z
  .object({
    generated_at: z.string().datetime(),
    kind: z.literal(SCHEDULE_KIND),
    root_workflow: z.string().regex(ID_RE),
    schedule_id: z.string().regex(SCHEDULE_ID_RE),
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
  phaseContext?: SchedulePhaseContext;
  runId?: string;
  task: string;
  worktreePath: string;
}

export interface GenerateScheduleResult {
  artifact: ScheduleArtifact;
  path: string;
}

export interface GenerateScheduleInMemoryResult {
  artifact: ScheduleArtifact;
  yaml: string;
}

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

export interface BacklogWorkUnit {
  acceptance_criteria: Array<{ id: string; text: string }>;
  dependencies?: string[];
  description?: string;
  id: string;
  title?: string;
}

export interface SchedulePlanningContext {
  parentWorkUnits: BacklogWorkUnit[];
  research?: ScheduleResearchContext;
  workUnits: BacklogWorkUnit[];
}

export interface ScheduleResearchContext {
  ac: string[];
  files?: string[];
  findings: string[];
  risks?: string[];
  target?: string;
}

export interface SchedulePhaseContext {
  research?: ScheduleResearchContext;
  ticketPlan?: TicketPlan;
}

/**
 * A backlog ticket's frontmatter may declare dependencies on sibling tickets
 * that are not part of this run (e.g. submitting TOVA-766.03 alone when its
 * frontmatter depends on TOVA-766.01). Those out-of-scope ids must not reach the
 * planner: it is instructed to preserve Backlog dependency ids as needs edges,
 * and an edge to a work unit that no node serves fails schedule validation. Prune
 * each unit's dependencies to the ids actually in scope (parent + work units) —
 * the same predicate workUnitDependencyIssues applies after generation — so the
 * planner prompt context and downstream validation stay consistent.
 */
export function pruneOutOfScopeDependencies(
  context: SchedulePlanningContext
): SchedulePlanningContext {
  const inScope = new Set(
    [...context.parentWorkUnits, ...context.workUnits].map((unit) => unit.id)
  );
  const prune = (unit: BacklogWorkUnit): BacklogWorkUnit =>
    unit.dependencies
      ? {
          ...unit,
          dependencies: unit.dependencies.filter((id) => inScope.has(id)),
        }
      : unit;
  return {
    parentWorkUnits: context.parentWorkUnits.map(prune),
    workUnits: context.workUnits.map(prune),
  };
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

export class ScheduleArtifactError extends Data.TaggedError(
  "ScheduleArtifactError"
)<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
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

  const { scheduledWorkflows, workflowId } = namespaceScheduleWorkflows(
    artifact,
    ScheduleArtifactError
  );

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
  const result = await generateScheduleArtifactInMemory(options);
  return {
    artifact: result.artifact,
    path: persistScheduleArtifact(options.worktreePath, result.artifact),
  };
}

export async function generateScheduleArtifactInMemory(
  options: GenerateScheduleOptions
): Promise<GenerateScheduleInMemoryResult> {
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
  const planningContext: SchedulePlanningContext = schedulePlanningContext({
    task: options.task,
    phaseContext: options.phaseContext,
    worktreePath: options.worktreePath,
  });
  const generatedArtifact = await planScheduleArtifact(
    baseline,
    policy.planner_profile,
    options,
    planningContext
  );
  assertSchedulePassOrder();
  // Generated schedules are normalized through auditable passes in this order:
  // coverage -> drain-merge -> delivery -> models -> IDs -> references.
  // Reference rewriting is applied by compileScheduleArtifact, where scheduled
  // workflows are merged into config.
  const artifact = hydrateScheduleTaskContexts(
    canonicalizeGeneratedScheduleIds(
      applyNodeCatalogModelFallbacks(
        options.config,
        policy.node_catalog,
        appendPullRequestDelivery(
          options.config,
          integrateParallelWriteFanout(
            options.config,
            addGeneratedImplementationCoverage(
              options.config,
              generatedArtifact
            )
          )
        )
      )
    ),
    planningContext
  );
  validateScheduleArtifact(options.config, artifact, planningContext);
  compileScheduleArtifact(options.config, artifact, options.worktreePath);
  return {
    artifact,
    yaml: stringify(artifact),
  };
}

export function schedulePlanningContext(input: {
  phaseContext?: SchedulePhaseContext;
  task: string;
  worktreePath: string;
}): SchedulePlanningContext {
  return pruneOutOfScopeDependencies(
    mergePhasePlanningContext(
      loadBacklogPlanningContext(input.task, input.worktreePath),
      input.phaseContext
    )
  );
}

function mergePhasePlanningContext(
  base: SchedulePlanningContext,
  phaseContext: SchedulePhaseContext | undefined
): SchedulePlanningContext {
  const planned = phaseContext?.ticketPlan
    ? ticketPlanPlanningContext(phaseContext.ticketPlan)
    : { parentWorkUnits: [], workUnits: [] };
  return {
    parentWorkUnits: [...base.parentWorkUnits, ...planned.parentWorkUnits],
    ...(phaseContext?.research ? { research: phaseContext.research } : {}),
    workUnits: [...base.workUnits, ...planned.workUnits],
  };
}

export function ticketPlanPlanningContext(
  plan: TicketPlan
): Pick<SchedulePlanningContext, "parentWorkUnits" | "workUnits"> {
  const localIds = new Map(
    plan.tickets.map((ticket) => [ticket.key, ticket.key])
  );
  return {
    parentWorkUnits: plan.epic ? [ticketPlanTaskWorkUnit(plan.epic)] : [],
    workUnits: plan.tickets.map((ticket) =>
      ticketPlanTaskWorkUnit(ticket, localIds)
    ),
  };
}

function ticketPlanTaskWorkUnit(
  task: TicketPlan["tickets"][number] | NonNullable<TicketPlan["epic"]>,
  localIds: ReadonlyMap<string, string> = new Map()
): BacklogWorkUnit {
  return {
    acceptance_criteria: task.acceptance_criteria.map((criterion, index) => ({
      id: `${task.key}-ac-${index + 1}`,
      text: criterion.text,
    })),
    dependencies:
      "depends_on" in task
        ? task.depends_on.flatMap((key) => {
            const id = localIds.get(key);
            return id ? [id] : [];
          })
        : [],
    description: task.description,
    id: task.key,
    title: task.title,
  };
}

function assertSchedulePassOrder(): void {
  const expected = [
    "coverage",
    "drain-merge",
    "delivery",
    "models",
    "ids",
    "references",
  ] as const;
  if (SCHEDULE_PASS_ORDER.join("\0") !== expected.join("\0")) {
    throw new ScheduleArtifactError("Schedule pass order is misconfigured");
  }
}

function persistScheduleArtifact(
  worktreePath: string,
  artifact: ScheduleArtifact
): string {
  ensurePipelineWorkspaceIgnore(worktreePath);
  const relativePath = join(
    ".pipeline",
    "runs",
    artifact.schedule_id,
    "schedule.yaml"
  );
  const fullPath = join(worktreePath, relativePath);
  mkdirSync(join(worktreePath, ".pipeline", "runs", artifact.schedule_id), {
    recursive: true,
  });
  writeFileSync(fullPath, stringify(artifact));
  return relativePath;
}

export function scheduleArtifactPath(
  worktreePath: string,
  scheduleId: string
): string {
  return join(worktreePath, ".pipeline", "runs", scheduleId, "schedule.yaml");
}

async function planScheduleArtifact(
  baseline: ScheduleArtifact,
  plannerProfile: string | undefined,
  options: GenerateScheduleOptions,
  planningContext: SchedulePlanningContext
): Promise<ScheduleArtifact> {
  const requiredPlannerProfile = requireSchedulePlannerProfile(
    plannerProfile,
    options.entrypointId
  );
  const ticketPlanFallback = ticketPlanScheduleArtifact(
    baseline,
    options.config,
    planningContext,
    options.phaseContext
  );
  const prompt = plannerPrompt(
    options.entrypointId,
    options.task,
    baseline,
    options.config,
    planningContext
  );
  const sourceResult = await runSchedulePlannerSource(
    requiredPlannerProfile,
    prompt,
    options
  );
  if (!sourceResult.ok) {
    if (ticketPlanFallback) {
      return ticketPlanFallback;
    }
    throw sourceResult.error;
  }
  const source = requireSchedulePlannerSource(sourceResult.source);

  const initial = acceptedGeneratedSchedule(
    parseGeneratedSchedule(source, "planner output")
  );
  if (initial.ok) {
    return initial.artifact;
  }

  const repair = await repairInvalidScheduleArtifact({
    baseline,
    initialFailure: initial.error,
    initialSource: source,
    options,
    plannerProfile: requiredPlannerProfile,
  });
  return scheduleArtifactAfterRepair(
    repair,
    ticketPlanFallback ?? baseline,
    initial.error,
    source
  );
}

async function runSchedulePlannerSource(
  plannerProfile: string,
  prompt: string,
  options: GenerateScheduleOptions
): Promise<
  { ok: true; source: string } | { error: ScheduleArtifactError; ok: false }
> {
  try {
    return {
      ok: true,
      source: await runSchedulePlanner(plannerProfile, prompt, options),
    };
  } catch (err) {
    if (err instanceof ScheduleArtifactError) {
      return { error: err, ok: false };
    }
    throw err;
  }
}

function ticketPlanScheduleArtifact(
  baseline: ScheduleArtifact,
  config: PipelineConfig,
  planningContext: SchedulePlanningContext,
  phaseContext: SchedulePhaseContext | undefined
): ScheduleArtifact | undefined {
  if (!phaseContext?.ticketPlan || planningContext.workUnits.length === 0) {
    return;
  }
  const implementationProfile = profileIdForSchedulingRole(
    config,
    "implementation",
    PREFERRED_IMPLEMENTATION_PROFILE_IDS
  );
  if (!implementationProfile) {
    throw new ScheduleArtifactError(
      "Cannot generate TicketPlan schedule: no profile declares scheduling role 'implementation'"
    );
  }
  const usedIds = new Set<string>();
  const nodeIdsByUnit = new Map(
    planningContext.workUnits.map((unit) => [
      unit.id,
      uniqueGeneratedId(`${unit.id}-implement`, usedIds, "work-implement"),
    ])
  );
  const nodes: WorkflowNode[] = planningContext.workUnits.map((unit) => {
    const needs = (unit.dependencies ?? []).flatMap((id) => {
      const nodeId = nodeIdsByUnit.get(id);
      return nodeId ? [nodeId] : [];
    });
    return {
      id: nodeIdsByUnit.get(unit.id) ?? "work-implement",
      kind: "agent",
      ...(needs.length > 0 ? { needs } : {}),
      profile: implementationProfile,
      task_context: { id: unit.id },
    };
  });
  return {
    ...baseline,
    root_workflow: "root",
    workflows: {
      root: {
        description: "Generated deterministic schedule from TicketPlan.",
        nodes,
      },
    },
  };
}

function profileIdForSchedulingRole(
  config: PipelineConfig,
  role: SchedulingRole,
  preferredIds: readonly string[]
): string | undefined {
  const matchingIds = Object.entries(config.profiles)
    .filter(([, profile]) => profile.scheduling_roles?.includes(role))
    .map(([id]) => id);
  return (
    preferredIds.find((id) => matchingIds.includes(id)) ?? matchingIds.sort()[0]
  );
}

function requireSchedulePlannerProfile(
  plannerProfile: string | undefined,
  entrypointId: string
): string {
  if (plannerProfile) {
    return plannerProfile;
  }
  throw new ScheduleArtifactError(
    `schedule '${entrypointId}' requires planner_profile`
  );
}

function requireSchedulePlannerSource(source: string): string {
  if (source) {
    return source;
  }
  throw new ScheduleArtifactError("schedule planner returned empty output");
}

function scheduleArtifactAfterRepair(
  repair: ScheduleRepairResult,
  baseline: ScheduleArtifact,
  initialFailure: ScheduleArtifactError,
  initialSource: string
): ScheduleArtifact {
  if (repair.kind === "accepted") {
    return repair.artifact;
  }
  if (repair.kind === "fallback") {
    return baseline;
  }
  throw new ScheduleArtifactError(
    [
      "Schedule planner produced invalid output after repair.",
      initialFailure.message,
      "Original planner output:",
      initialSource,
      repair.latestFailure.message,
      "Planner repair output:",
      repair.latestSource,
    ].join("\n")
  );
}

type ScheduleRepairResult =
  | { artifact: ScheduleArtifact; kind: "accepted" }
  | { kind: "fallback" }
  | {
      kind: "invalid";
      latestFailure: ScheduleArtifactError;
      latestSource: string;
    };

async function repairInvalidScheduleArtifact(input: {
  baseline: ScheduleArtifact;
  initialFailure: ScheduleArtifactError;
  initialSource: string;
  options: GenerateScheduleOptions;
  plannerProfile: string;
}): Promise<ScheduleRepairResult> {
  let latestFailure = input.initialFailure;
  let latestSource = input.initialSource;
  for (
    let attempt = 1;
    attempt <= SCHEDULE_PLANNER_REPAIR_ATTEMPTS;
    attempt += 1
  ) {
    const repairedSource = await runScheduleRepair(
      input,
      latestFailure,
      latestSource,
      attempt
    );
    if (!repairedSource) {
      return { kind: "fallback" };
    }
    const repaired = acceptedGeneratedSchedule(
      parseGeneratedSchedule(repairedSource, "planner repair output")
    );
    if (repaired.ok) {
      return { artifact: repaired.artifact, kind: "accepted" };
    }
    latestFailure = repaired.error;
    latestSource = repairedSource;
  }
  return { kind: "invalid", latestFailure, latestSource };
}

async function runScheduleRepair(
  input: {
    baseline: ScheduleArtifact;
    options: GenerateScheduleOptions;
    plannerProfile: string;
  },
  latestFailure: ScheduleArtifactError,
  latestSource: string,
  attempt: number
): Promise<string | undefined> {
  try {
    return await runSchedulePlanner(
      input.plannerProfile,
      plannerRepairPrompt({
        attempt,
        baseline: input.baseline,
        error: latestFailure,
        source: latestSource,
      }),
      input.options,
      "schedule-plan-repair"
    );
  } catch (err) {
    if (err instanceof ScheduleArtifactError) {
      return;
    }
    throw err;
  }
}

function parseGeneratedSchedule(
  source: string,
  sourcePath: string
):
  | { artifact: ScheduleArtifact; ok: true }
  | { error: ScheduleArtifactError; ok: false } {
  const parseableSource = normalizeGeneratedScheduleSource(source);
  try {
    return {
      artifact: parseScheduleArtifact(parseableSource, sourcePath),
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

function normalizeGeneratedScheduleSource(source: string): string {
  const fenced = MARKDOWN_YAML_FENCE_RE.exec(source);
  return fenced?.[1] ?? source;
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
  result: {
    exitCode: number;
    stderr?: string;
    stdout: string;
    timedOut?: boolean;
  }
): string {
  const details = [
    result.timedOut ? "timed out waiting for scheduler subprocess" : undefined,
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : undefined,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const message = `schedule planner '${plannerProfile}' failed with exit ${result.exitCode}`;
  return details.length === 0 ? message : `${message}\n${details.join("\n")}`;
}

function validateScheduleArtifact(
  config: PipelineConfig,
  artifact: ScheduleArtifact,
  planningContext: SchedulePlanningContext
): void {
  const issues = [
    ...generatedRootWorkflowIssues(artifact),
    ...missingAssignedWorkUnitIssues(artifact, planningContext.workUnits),
    ...workUnitDependencyIssues(config, artifact, planningContext.workUnits),
    ...unsupportedGeneratedBuiltinIssues(artifact),
    ...implementationCoverageIssues(config, artifact),
    ...unsafeParallelWorktreeIssues(config, artifact),
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

function unsafeParallelWorktreeIssues(
  config: PipelineConfig,
  artifact: ScheduleArtifact
): string[] {
  return workflowNodeIssues(
    artifact,
    ({ dependentsByNeed, nodes, workflowId }) =>
      nodes
        .filter((node) => node.kind === "parallel")
        .flatMap((node) => {
          const writeCapable = node.nodes.filter((child) =>
            isWriteCapableParallelChild(config, child)
          );
          if (writeCapable.length <= 1) {
            return [];
          }
          if (hasDownstreamDrainMerge(node.id, dependentsByNeed)) {
            return [];
          }
          return [
            `parallel node '${workflowId}.${node.id}' has write-capable children sharing a worktree without isolated worktree roots or drain-merge integration`,
          ];
        })
  );
}

interface WorkflowNodeIssueContext {
  dependentsByNeed: Map<string, WorkflowNode[]>;
  nodes: WorkflowNode[];
  workflowId: string;
}

// A parallel node completes only when its children do, so downstream consumers
// of the parallel transitively depend on each child. Register that containment
// edge (child -> parent parallel) so reachability flows from a nested child out
// to the parallel's own dependents (e.g. a best-of-N candidate -> select-
// candidate -> verification).
function registerContainmentEdge(
  parent: WorkflowNode,
  child: WorkflowNode,
  index: Map<string, WorkflowNode[]>
): void {
  const dependents = index.get(child.id) ?? [];
  dependents.push(parent);
  index.set(child.id, dependents);
}

function addParallelContainmentEdges(
  nodes: WorkflowNode[],
  index: Map<string, WorkflowNode[]>
): void {
  for (const node of nodes) {
    if (node.kind !== "parallel") {
      continue;
    }
    for (const child of node.nodes) {
      registerContainmentEdge(node, child, index);
    }
    addParallelContainmentEdges(node.nodes, index);
  }
}

function dependentsByNeedWithContainment(
  nested: WorkflowNode[],
  flat: WorkflowNode[]
): Map<string, WorkflowNode[]> {
  const index = dependentsByNeed(flat);
  addParallelContainmentEdges(nested, index);
  return index;
}

function workflowNodeIssues(
  artifact: ScheduleArtifact,
  collectIssues: (context: WorkflowNodeIssueContext) => string[]
): string[] {
  return Object.entries(artifact.workflows).flatMap(
    ([workflowId, workflow]) => {
      const nodes = flattenWorkflowNodes(workflow.nodes);
      return collectIssues({
        dependentsByNeed: dependentsByNeedWithContainment(
          workflow.nodes,
          nodes
        ),
        nodes,
        workflowId,
      });
    }
  );
}

function hasDownstreamDrainMerge(
  nodeId: string,
  index: Map<string, WorkflowNode[]>
): boolean {
  return hasReachableDependent(
    nodeId,
    index,
    (node) =>
      node.kind === "builtin" && PARALLEL_MERGE_BUILTINS.has(node.builtin)
  );
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
      const nodes = flattenWorkflowNodes(workflow.nodes);
      const index = dependentsByNeedWithContainment(workflow.nodes, nodes);
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
                hasReachableDependent(
                  source.id,
                  index,
                  (candidate) => candidate.id === node.id
                )
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
  return workflowNodeIssues(
    artifact,
    ({ dependentsByNeed, nodes, workflowId }) =>
      nodes
        .filter((node) => isImplementationNode(config, node))
        .filter(
          (node) => !hasDownstreamCoverage(config, node.id, dependentsByNeed)
        )
        .map(
          (node) =>
            `implementation node '${workflowId}.${node.id}' is without downstream verification or review`
        )
  );
}

function hasDownstreamCoverage(
  config: PipelineConfig,
  nodeId: string,
  index: Map<string, WorkflowNode[]>
): boolean {
  return hasReachableDependent(nodeId, index, (node) =>
    isCoverageNode(config, node)
  );
}

function allWorkflowNodes(
  workflows: ScheduleArtifact["workflows"]
): WorkflowNode[] {
  return Object.values(workflows).flatMap((workflow) =>
    flattenWorkflowNodes(workflow.nodes)
  );
}

function flattenWorkflowNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  return flattenNodes(nodes, (node) =>
    node.kind === "parallel" ? node.nodes : undefined
  );
}
