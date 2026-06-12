import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../planner";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

const GENERATED_ID_INVALID_CHARS_RE = /[^a-z0-9]+/g;
const GENERATED_ID_TRIM_HYPHENS_RE = /^-+|-+$/g;
const STARTS_WITH_ALPHA_RE = /^[a-z]/;

export function canonicalizeGeneratedScheduleIds(
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

function flattenWorkflowNode(node: WorkflowNode): WorkflowNode[] {
  return node.kind === "parallel"
    ? [node, ...node.nodes.flatMap(flattenWorkflowNode)]
    : [node];
}
