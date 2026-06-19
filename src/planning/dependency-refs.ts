import type { WorkflowNodeKind } from "../config";
import { uniqueStrings } from "../strings";
import type { PlannedWorkflowNode } from "./compile";

/**
 * Index every planned node — including the children nested inside `parallel`
 * containers — by id, so a dependency id can be resolved regardless of nesting.
 */
export function indexPlannedNodesById(
  nodes: readonly PlannedWorkflowNode[],
  into: Map<string, PlannedWorkflowNode> = new Map()
): Map<string, PlannedWorkflowNode> {
  for (const node of nodes) {
    into.set(node.id, node);
    indexPlannedNodesById(node.children ?? [], into);
  }
  return into;
}

/**
 * Expand dependency ids to the executable (branch-producing) leaf node ids,
 * making `group`/`parallel` container nodes transparent.
 *
 * A container produces no output of its own: a `parallel` lowers to its children
 * and a `group` is a pure dependency anchor, so neither pushes a `nodes/<id>`
 * result branch. A downstream node that lists the container in `needs` actually
 * depends on the container's executable descendants. Both the Argo DAG ordering
 * and the runner's upstream-output (git ref) materialization resolve dependencies
 * through this one function so the two representations never diverge — divergence
 * is what made review nodes fetch a non-existent `nodes/mechanical-checks` branch.
 */
export function resolveExecutableDependencyIds(
  nodeById: ReadonlyMap<string, PlannedWorkflowNode>,
  needs: readonly string[]
): string[] {
  const resolveOne = (nodeId: string): string[] => {
    const node = nodeById.get(nodeId);
    if (!node) {
      return [];
    }
    const kind: WorkflowNodeKind = node.kind;
    switch (kind) {
      case "agent":
      case "builtin":
      case "command":
        return [node.id];
      case "group":
        // Groups normalize their members into `needs` during planning, but keep
        // the `nodes` list too; resolve through both for robustness.
        return uniqueStrings(
          [...(node.nodes ?? []), ...node.needs].flatMap(resolveOne)
        );
      case "parallel":
        return uniqueStrings(
          (node.children ?? []).flatMap((child) => resolveOne(child.id))
        );
      default: {
        const exhaustive: never = kind;
        throw new Error(
          `resolveExecutableDependencyIds: unsupported node kind '${String(exhaustive)}' on '${node.id}'`
        );
      }
    }
  };
  return uniqueStrings(needs.flatMap(resolveOne));
}
