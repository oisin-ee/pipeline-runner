import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import {
  type PipelineConfig,
  type ScheduleBaseline,
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
import { parseTicketAndDescription } from "./task-ref.js";
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
const LINE_RE = /\r?\n/;

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
  description?: string;
  id: string;
  title?: string;
}

interface SchedulePlanningContext {
  parentWorkUnit?: BacklogWorkUnit;
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
    entrypointId: options.entrypointId,
    generatedAt: options.generatedAt ?? new Date(),
    runId: options.runId,
    task: options.task,
  });
  const planningContext: SchedulePlanningContext = {
    ...loadBacklogPlanningContext(options.task, options.worktreePath),
  };
  const artifact = await planScheduleArtifact(
    baseline,
    policy.planner_profile,
    options,
    planningContext
  );
  validateScheduleArtifact(options.config, artifact, planningContext);
  compileScheduleArtifact(options.config, artifact, options.worktreePath);
  const path = scheduleArtifactPath(options.worktreePath, artifact.schedule_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(artifact), "utf8");
  return { artifact, path };
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
  entrypointId: string;
  generatedAt: Date;
  runId?: string;
  task: string;
}): ScheduleArtifact {
  const scheduleId = input.runId ?? defaultScheduleId(input.generatedAt);
  return {
    generated_at: input.generatedAt.toISOString(),
    kind: SCHEDULE_KIND,
    root_workflow: "root",
    schedule_id: scheduleId,
    source_entrypoint: input.entrypointId,
    task: input.task,
    version: 1,
    workflows:
      input.baseline === "epic"
        ? epicBaselineWorkflow()
        : pipeBaselineWorkflow(),
  };
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
      description: "Generated epic schedule.",
      nodes: [
        { id: "research", kind: "agent", profile: "pipeline-researcher" },
        {
          id: "implement",
          kind: "parallel",
          needs: ["research"],
          nodes: [
            implementationTrack("test"),
            implementationTrack("frontend"),
            implementationTrack("backend"),
            implementationTrack("k8s"),
          ],
        },
        {
          builtin: "drain-merge",
          id: "merge",
          kind: "builtin",
          needs: ["implement"],
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
    track: {
      description: "Generated implementation track.",
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

function implementationTrack(id: string): WorkflowNode {
  return {
    id,
    kind: "workflow",
    workflow: "track",
    worktree_root: `.pipeline/runs/\${runId}/${id}`,
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
  const source = await runSchedulePlanner(
    plannerProfile,
    plannerPrompt(
      options.entrypointId,
      options.task,
      baseline,
      options.config,
      planningContext
    ),
    options
  );
  if (!source) {
    throw new ScheduleArtifactError("schedule planner returned empty output");
  }
  return parseScheduleArtifact(source, "planner output");
}

async function runSchedulePlanner(
  plannerProfile: string,
  prompt: string,
  options: GenerateScheduleOptions
): Promise<string> {
  const executor = options.executor ?? runLaunchPlan;
  const plan = createRunnerLaunchPlan(options.config, {
    nodeId: "schedule-plan",
    profileId: plannerProfile,
    prompt,
    worktreePath: options.worktreePath,
  });
  const result = await executor(plan, {});
  if (result.exitCode !== 0) {
    throw new ScheduleArtifactError(
      `schedule planner '${plannerProfile}' failed with exit ${result.exitCode}`
    );
  }
  return normalizeRunnerOutput(plan, result.stdout).output.trim();
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
    "Preserve version, kind, schedule_id, source_entrypoint, task, generated_at, and root_workflow unless a graph change requires new workflow ids.",
    "Every workflow reference must point at a workflow embedded in the artifact.",
    "Use only the allowed configured profiles and workflows listed below. Do not invent profile ids, workflow ids, or node-level skill overrides.",
    "Assign exactly one implementation branch to each backlog work unit. Put that unit's task_context on the branch workflow node or on its implementation node.",
    "Implementation work must have downstream acceptance, verification, or review coverage in the generated DAG.",
    "",
    "Allowed profiles:",
    ...Object.keys(config.profiles)
      .sort()
      .map((id) => `- ${id}`),
    "",
    "Allowed workflows:",
    ...Object.keys(config.workflows)
      .sort()
      .map((id) => `- ${id}`),
    "",
    "Gate recipes:",
    "- RED/test coverage may use changed_files gates on test-writing nodes.",
    "- Acceptance coverage may use acceptance and verdict gates.",
    "- Verification may use builtin typecheck, test, semgrep, duplication, plus verdict gates.",
    "",
    "Backlog work units:",
    planningContext.workUnits.length > 0
      ? stringify(planningContext.workUnits)
      : "No backlog child tickets were resolved; decompose the prompt conservatively.",
    "",
    "Backlog parent context:",
    planningContext.parentWorkUnit
      ? stringify(planningContext.parentWorkUnit)
      : "No backlog parent context was resolved.",
    "",
    "Baseline schedule:",
    stringify(baseline),
  ].join("\n");
}

function validateScheduleArtifact(
  config: PipelineConfig,
  artifact: ScheduleArtifact,
  planningContext: SchedulePlanningContext
): void {
  const issues = [
    ...missingAssignedWorkUnitIssues(artifact, planningContext.workUnits),
    ...invalidWorkflowPrimitiveIssues(config, artifact),
    ...implementationCoverageIssues(artifact),
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

function implementationCoverageIssues(artifact: ScheduleArtifact): string[] {
  return Object.entries(artifact.workflows).flatMap(([workflowId, workflow]) =>
    workflow.nodes
      .filter(isImplementationNode)
      .filter((node) => !hasDownstreamCoverage(node.id, workflow.nodes))
      .map(
        (node) =>
          `implementation node '${workflowId}.${node.id}' is without downstream verification or review`
      )
  );
}

function isImplementationNode(node: WorkflowNode): boolean {
  return node.kind === "agent" && node.profile === "pipeline-code-writer";
}

function hasDownstreamCoverage(nodeId: string, nodes: WorkflowNode[]): boolean {
  const byNeed = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      const dependents = byNeed.get(need) ?? [];
      dependents.push(node);
      byNeed.set(need, dependents);
    }
  }
  const queue = [...(byNeed.get(nodeId) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    if (isCoverageNode(node)) {
      return true;
    }
    queue.push(...(byNeed.get(node.id) ?? []));
  }
  return false;
}

function isCoverageNode(node: WorkflowNode): boolean {
  if (node.kind !== "agent") {
    return false;
  }
  return [
    "pipeline-acceptance-reviewer",
    "pipeline-thermo-nuclear-reviewer",
    "pipeline-verifier",
  ].includes(node.profile);
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
): Pick<SchedulePlanningContext, "parentWorkUnit" | "workUnits"> {
  const ticketId = parseTicketAndDescription(task).ticketId;
  if (!ticketId) {
    return { workUnits: [] };
  }
  const tasks = readBacklogTasks(worktreePath);
  const parentWorkUnit = tasks.find(
    (taskFile) => taskFile.id === ticketId
  )?.workUnit;
  const workUnits = tasks
    .filter((taskFile) => taskFile.parentTaskId === ticketId)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((taskFile) => taskFile.workUnit);
  return {
    ...(parentWorkUnit ? { parentWorkUnit } : {}),
    workUnits,
  };
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

function optionalStringField<TKey extends string>(
  key: TKey,
  value: string | undefined
): Record<TKey, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<TKey, string>) : {};
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
