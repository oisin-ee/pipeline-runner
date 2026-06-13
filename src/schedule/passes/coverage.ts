import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";
import { dependentsByNeed, hasReachableDependent } from "../../planning/graph";
import { uniqueGeneratedId } from "../../strings";
import { isCoverageNode, isImplementationNode } from "../scheduling-roles";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

const DEFAULT_GENERATED_COVERAGE_PROFILE_PREFERENCE = [
  "moka-verifier",
  "moka-acceptance-reviewer",
  "moka-thermo-nuclear-reviewer",
];

export function addGeneratedImplementationCoverage(
  config: PipelineConfig,
  artifact: ScheduleArtifact
): ScheduleArtifact {
  const coverageProfileId = generatedCoverageProfileId(config);
  if (!coverageProfileId) {
    return artifact;
  }
  return {
    ...artifact,
    workflows: Object.fromEntries(
      Object.entries(artifact.workflows).map(([id, workflow]) => [
        id,
        addWorkflowImplementationCoverage(config, workflow, coverageProfileId),
      ])
    ),
  };
}

function addWorkflowImplementationCoverage(
  config: PipelineConfig,
  workflow: Workflow,
  coverageProfileId: string
): Workflow {
  return {
    ...workflow,
    nodes: addNodeScopeImplementationCoverage(
      config,
      workflow.nodes,
      coverageProfileId
    ),
  };
}

function addNodeScopeImplementationCoverage(
  config: PipelineConfig,
  nodes: WorkflowNode[],
  coverageProfileId: string
): WorkflowNode[] {
  const scopedNodes = nodes.map((node) =>
    node.kind === "parallel"
      ? {
          ...node,
          nodes: addNodeScopeImplementationCoverage(
            config,
            node.nodes,
            coverageProfileId
          ),
        }
      : node
  );
  const index = dependentsByNeed(scopedNodes);
  const uncovered = scopedNodes
    .filter((node) => isImplementationNode(config, node))
    .filter((node) => !hasDownstreamCoverage(config, node.id, index));
  if (uncovered.length === 0) {
    return scopedNodes;
  }
  const usedIds = new Set(scopedNodes.map((node) => node.id));
  const coverageNodeId = uniqueGeneratedId(
    "generated-coverage",
    usedIds,
    "generated-coverage"
  );
  return [
    ...scopedNodes,
    {
      gates: generatedCoverageGates(coverageNodeId),
      id: coverageNodeId,
      kind: "agent",
      needs: uncovered.map((node) => node.id),
      profile: coverageProfileId,
    },
  ];
}

function generatedCoverageProfileId(config: PipelineConfig): string | null {
  const coverageProfiles = Object.entries(config.profiles)
    .filter(([, profile]) => profile.scheduling_roles?.includes("coverage"))
    .map(([id]) => id);
  if (coverageProfiles.length === 0) {
    return null;
  }
  return (
    DEFAULT_GENERATED_COVERAGE_PROFILE_PREFERENCE.find((id) =>
      coverageProfiles.includes(id)
    ) ??
    coverageProfiles.sort()[0] ??
    null
  );
}

function generatedCoverageGates(
  nodeId: string
): NonNullable<WorkflowNode["gates"]> {
  return [
    { builtin: "typecheck", id: `${nodeId}-typecheck`, kind: "builtin" },
    { builtin: "test", id: `${nodeId}-tests`, kind: "builtin" },
    { builtin: "lint", id: `${nodeId}-lint`, kind: "builtin" },
    { builtin: "fallow", id: `${nodeId}-fallow`, kind: "builtin" },
    { builtin: "semgrep", id: `${nodeId}-semgrep`, kind: "builtin" },
    {
      builtin: "duplication",
      id: `${nodeId}-duplication`,
      kind: "builtin",
    },
    { id: `${nodeId}-verdict`, kind: "verdict", target: "stdout" },
  ];
}

function hasDownstreamCoverage(
  config: PipelineConfig,
  nodeId: string,
  index: Map<string, WorkflowNode[]>
): boolean {
  return hasReachableDependent(nodeId, index, (node) =>
    isCoverageNode(config, node)
  );
}
