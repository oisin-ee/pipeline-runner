import type { PlannedWorkflowNode } from "./planning/compile";
import { findNode } from "./planning/graph";

export function findPlannedNode(
  nodes: PlannedWorkflowNode[],
  nodeId: string
): PlannedWorkflowNode | undefined {
  return findNode(nodes, nodeId, (node) => node.children);
}
