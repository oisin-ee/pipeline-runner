import type { PlannedWorkflowNode } from "./workflow-planner";

export function findPlannedNode(
  nodes: PlannedWorkflowNode[],
  nodeId: string
): PlannedWorkflowNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node;
    }
    const child = findPlannedNode(node.children ?? [], nodeId);
    if (child) {
      return child;
    }
  }
  return;
}
