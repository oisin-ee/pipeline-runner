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
          nodes: workflow.nodes.map((node) =>
            expandNode(node, bestOfN.categories, bestOfN.n)
          ),
        },
      ])
    ),
  };
}

function expandNode(
  node: WorkflowNode,
  categories: string[],
  n: number
): WorkflowNode {
  if (
    node.kind !== "agent" ||
    !categories.some((category) => node.id.includes(category))
  ) {
    return node;
  }
  const children: WorkflowNode[] = Array.from({ length: n }, (_, index) => ({
    ...node,
    id: `${node.id}--c${index + 1}`,
    needs: [],
  }));
  return {
    id: node.id,
    kind: "parallel",
    nodes: children,
    ...(node.needs ? { needs: node.needs } : {}),
  };
}
