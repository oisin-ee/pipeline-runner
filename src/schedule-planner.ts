import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import {
  compileWorkflowPlan,
  type WorkflowExecutionPlan,
} from "./workflow-planner.js";

const SCHEDULE_KIND = "pipeline-schedule";
const ID_RE = /^[a-z][a-z0-9-]*$/;

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

  const artifact = await refineScheduleArtifact(
    baselineScheduleArtifact({
      baseline: policy.baseline,
      entrypointId: options.entrypointId,
      generatedAt: options.generatedAt ?? new Date(),
      runId: options.runId,
      task: options.task,
    }),
    policy.planner_profile,
    options
  );
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

async function refineScheduleArtifact(
  baseline: ScheduleArtifact,
  plannerProfile: string | undefined,
  options: GenerateScheduleOptions
): Promise<ScheduleArtifact> {
  if (!plannerProfile) {
    return baseline;
  }
  const executor = options.executor ?? runLaunchPlan;
  const plan = createRunnerLaunchPlan(options.config, {
    nodeId: "schedule-plan",
    profileId: plannerProfile,
    prompt: plannerPrompt(options.entrypointId, options.task, baseline),
    worktreePath: options.worktreePath,
  });
  const result = await executor(plan, {});
  if (result.exitCode !== 0) {
    throw new ScheduleArtifactError(
      `schedule planner '${plannerProfile}' failed with exit ${result.exitCode}`
    );
  }
  const source = result.stdout.trim();
  if (!source) {
    return baseline;
  }
  return parseScheduleArtifact(source, "planner output");
}

function plannerPrompt(
  entrypointId: string,
  task: string,
  baseline: ScheduleArtifact
): string {
  return [
    `Create a pipeline schedule for entrypoint '${entrypointId}'.`,
    `Task: ${task}`,
    "Return only YAML matching kind: pipeline-schedule.",
    "Preserve version, kind, schedule_id, source_entrypoint, task, generated_at, and root_workflow unless a graph change requires new workflow ids.",
    "Every workflow reference must point at a workflow embedded in the artifact.",
    "",
    "Baseline schedule:",
    stringify(baseline),
  ].join("\n");
}

function defaultScheduleId(date: Date): string {
  return `run-${date
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
}
