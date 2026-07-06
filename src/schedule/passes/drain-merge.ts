import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";
import { dependentsByNeed, hasReachableDependent } from "../../planning/graph";
import { uniqueGeneratedId } from "../../strings";
import { isWriteCapableParallelChild } from "../scheduling-roles";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

const DRAIN_MERGE_BUILTIN = "drain-merge";

const isUnintegratedWriteFanout = (config: PipelineConfig, node: WorkflowNode): boolean =>
  node.kind === "parallel" && node.nodes.filter((child) => isWriteCapableParallelChild(config, child)).length > 1;

const hasDrainMerge = (parallelId: string, index: Map<string, WorkflowNode[]>): boolean =>
  hasReachableDependent(parallelId, index, (node) => node.kind === "builtin" && node.builtin === DRAIN_MERGE_BUILTIN);

// Repoint a dependent of the parallel at the inserted drain-merge so downstream
// work runs after integration, not concurrently with it. Nodes that do not
// depend on the parallel are returned unchanged.
const rerouteNeed = (node: WorkflowNode, from: string, to: string): WorkflowNode => {
  if (node.needs?.includes(from) !== true) {
    return node;
  }
  const needs = node.needs.map((need) => (need === from ? to : need));
  return { ...node, needs: [...new Set(needs)] };
};

const insertDrainMerge = (nodes: WorkflowNode[], parallelId: string, usedIds: Set<string>): WorkflowNode[] => {
  const mergeId = uniqueGeneratedId(`generated-drain-merge-${parallelId}`, usedIds, "generated-drain-merge");
  const rerouted = nodes.map((node) => rerouteNeed(node, parallelId, mergeId));
  const mergeNode: WorkflowNode = {
    builtin: DRAIN_MERGE_BUILTIN,
    id: mergeId,
    kind: "builtin",
    needs: [parallelId],
  };
  return [...rerouted, mergeNode];
};

const integrateNodeList = (config: PipelineConfig, nodes: WorkflowNode[]): WorkflowNode[] => {
  const index = dependentsByNeed(nodes);
  const unintegrated = nodes.filter(
    (node) => isUnintegratedWriteFanout(config, node) && !hasDrainMerge(node.id, index),
  );
  if (unintegrated.length === 0) {
    return nodes;
  }
  const usedIds = new Set(nodes.map((node) => node.id));
  return unintegrated.reduce((current, parallel) => insertDrainMerge(current, parallel.id, usedIds), nodes);
};

/**
 * A parallel node whose children mutate a shared worktree must hand its results
 * to a downstream `drain-merge` builtin (the schedule validator rejects it
 * otherwise). The planner is instructed to emit one, but the integration cannot
 * depend on planner cooperation: this pass deterministically inserts the missing
 * `drain-merge` after any parallel node with more than one write-capable child
 * that lacks one, and reroutes the parallel's existing dependents through it so
 * the merge is a true join point. Single-writer or already-integrated parallels
 * are left untouched.
 */
export const integrateParallelWriteFanout = (config: PipelineConfig, artifact: ScheduleArtifact): ScheduleArtifact => ({
  ...artifact,
  workflows: Object.fromEntries(
    Object.entries(artifact.workflows).map(([id, workflow]) => [
      id,
      { ...workflow, nodes: integrateNodeList(config, workflow.nodes) },
    ]),
  ),
});
