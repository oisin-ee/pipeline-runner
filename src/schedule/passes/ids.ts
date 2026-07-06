import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";
import { flattenNodes } from "../../planning/graph";
import { uniqueGeneratedId } from "../../strings";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

const rewriteGeneratedWorkflowNodeIds = (node: WorkflowNode, nodeIdMap: Map<string, string>): WorkflowNode => {
  const rewritten = {
    ...node,
    id: nodeIdMap.get(node.id) ?? node.id,
    ...(node.needs ? { needs: node.needs.map((need) => nodeIdMap.get(need) ?? need) } : {}),
  };
  return rewritten.kind === "parallel"
    ? {
        ...rewritten,
        nodes: rewritten.nodes.map((child) => rewriteGeneratedWorkflowNodeIds(child, nodeIdMap)),
      }
    : rewritten;
};

const canonicalizeWorkflowNodeIds = (workflow: Workflow): Workflow => {
  const nodeIdMap = new Map<string, string>();
  const usedNodeIds = new Set<string>();
  for (const node of flattenNodes(workflow.nodes, (node) => (node.kind === "parallel" ? node.nodes : undefined))) {
    nodeIdMap.set(node.id, uniqueGeneratedId(node.id, usedNodeIds, "node"));
  }
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => rewriteGeneratedWorkflowNodeIds(node, nodeIdMap)),
  };
};

export const canonicalizeGeneratedScheduleIds = (artifact: ScheduleArtifact): ScheduleArtifact => ({
  ...artifact,
  workflows: Object.fromEntries(
    Object.entries(artifact.workflows).map(([workflowId, workflow]) => [
      workflowId,
      canonicalizeWorkflowNodeIds(workflow),
    ]),
  ),
});
