import { findNode } from "./planning/graph";
import type { PlannedWorkflowNode } from "./workflow-planner";

export function findPlannedNode(
  nodes: PlannedWorkflowNode[],
  nodeId: string
): PlannedWorkflowNode | undefined {
  return findNode(nodes, nodeId, (node) => node.children);
}
