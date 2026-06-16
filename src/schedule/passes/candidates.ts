import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

/**
 * PIPE-83.7: best-of-N candidate generation. When config.best_of_n is enabled
 * with n > 1, each agent node whose id carries a configured category (e.g.
 * "green") is expanded into a kind:parallel node holding N candidate children
 * (each a full copy with a fresh id and no inter-candidate deps). The wrapper
 * keeps the original id + upstream needs, so downstream consumers and the
 * PIPE-83.9 selector see a single dependency. Default off / n=1 is identity, so
 * generated schedules and the PIPE-57 goldens are unchanged.
 */
export function expandBestOfNCandidates(
  config: PipelineConfig,
  artifact: ScheduleArtifact
): ScheduleArtifact {
  const bestOfN = config.best_of_n;
  if (!bestOfN?.enabled || bestOfN.n <= 1) {
    return artifact;
  }
  return {
    ...artifact,
    workflows: Object.fromEntries(
      Object.entries(artifact.workflows).map(([id, workflow]) => [
        id,
        {
          ...workflow,
          nodes: workflow.nodes.flatMap((node) =>
            expandNode(node, bestOfN.categories, bestOfN.n)
          ),
        },
      ])
    ),
  };
}

// A candidate inherits the node's config but NOT its work-unit assignment: the
// select-candidate node is the unit's representative, so candidates stay
// unassigned (and the work-unit dependency validator treats select-candidate,
// not the candidates, as the unit's node).
function candidateChild(node: WorkflowNode, index: number): WorkflowNode {
  const child: WorkflowNode = {
    ...node,
    id: `${node.id}--c${index + 1}`,
    needs: [],
  };
  child.task_context = undefined;
  return child;
}

function expandNode(
  node: WorkflowNode,
  categories: string[],
  n: number
): WorkflowNode[] {
  if (
    node.kind !== "agent" ||
    !categories.some((category) => node.id.includes(category))
  ) {
    return [node];
  }
  const candidatesId = `${node.id}--candidates`;
  const children: WorkflowNode[] = Array.from({ length: n }, (_, index) =>
    candidateChild(node, index)
  );
  // Parallel candidates feed a select-candidate builtin that keeps the original
  // node id (so the consumer's `needs` resolves to the selected winner) and
  // carries the original task_context so the work unit stays assigned + ordered.
  return [
    {
      id: candidatesId,
      kind: "parallel",
      nodes: children,
      ...(node.needs ? { needs: node.needs } : {}),
    },
    selectCandidateNode(node, candidatesId),
  ];
}

function selectCandidateNode(
  node: WorkflowNode,
  candidatesId: string
): WorkflowNode {
  return {
    builtin: "select-candidate",
    id: node.id,
    kind: "builtin",
    needs: [candidatesId],
    ...(node.task_context ? { task_context: node.task_context } : {}),
  };
}
