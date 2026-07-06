import type { Option } from "effect/Option";
import { getOrUndefined, none, some } from "effect/Option";

import type { PlannedWorkflowNode } from "./planning/compile";
import { findNode } from "./planning/graph";

const findPlannedNodeOption = (nodes: PlannedWorkflowNode[], nodeId: string): Option<PlannedWorkflowNode> => {
  const node = findNode(nodes, nodeId, (value) => value.children);
  return node === undefined ? none() : some(node);
};

export const findPlannedNode = (nodes: PlannedWorkflowNode[], nodeId: string) =>
  getOrUndefined(findPlannedNodeOption(nodes, nodeId));
