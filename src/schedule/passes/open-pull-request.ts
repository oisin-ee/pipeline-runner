import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";
import { dependentsByNeed } from "../../planning/graph";
import { uniqueGeneratedId } from "../../strings";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

const OPEN_PR_BUILTIN = "open-pull-request";

/** True when pull_request delivery is opted in via config. */
export const isPullRequestDeliveryEnabled = (config: PipelineConfig): boolean =>
  config.delivery?.pull_request?.enabled === true;

export const shouldAppendPullRequestDelivery = (input: { config: PipelineConfig; requested?: boolean }): boolean =>
  input.requested === true || isPullRequestDeliveryEnabled(input.config);

/** True when the node list already has an open-pull-request builtin. */
const hasPullRequestNode = (nodes: WorkflowNode[]): boolean =>
  nodes.some((node) => node.kind === "builtin" && node.builtin === OPEN_PR_BUILTIN);

/** Collect top-level node ids that no other top-level node depends on. */
const terminalNodeIds = (nodes: WorkflowNode[]): string[] => {
  const dependents = dependentsByNeed(nodes);
  return nodes.map((node) => node.id).filter((id) => (dependents.get(id)?.length ?? 0) === 0);
};

/** Build a single open-pull-request builtin node depending on all terminals. */
const buildPrNode = (terminalIds: string[], usedIds: Set<string>): WorkflowNode => {
  const id = uniqueGeneratedId("generated-open-pull-request", usedIds, "generated-open-pull-request");
  return { builtin: OPEN_PR_BUILTIN, id, kind: "builtin", needs: terminalIds };
};

/** Append a final open-pull-request node to the root workflow when enabled. */
export const appendPullRequestDelivery = (enabled: boolean, artifact: ScheduleArtifact): ScheduleArtifact => {
  if (!enabled) {
    return artifact;
  }
  if (!Object.hasOwn(artifact.workflows, artifact.root_workflow)) {
    return artifact;
  }
  const rootWorkflow = artifact.workflows[artifact.root_workflow];
  const { nodes } = rootWorkflow;
  if (hasPullRequestNode(nodes)) {
    return artifact;
  }
  const terminals = terminalNodeIds(nodes);
  if (terminals.length === 0) {
    return artifact;
  }
  const usedIds = new Set(nodes.map((node) => node.id));
  const prNode = buildPrNode(terminals, usedIds);
  return {
    ...artifact,
    workflows: {
      ...artifact.workflows,
      [artifact.root_workflow]: {
        ...rootWorkflow,
        nodes: [...nodes, prNode],
      },
    },
  };
};
