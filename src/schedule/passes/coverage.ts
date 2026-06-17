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
  const index = dependentsByNeed(nodes);
  const uncovered = nodes
    .filter((node) => nodeNeedsImplementationCoverage(config, node))
    .filter((node) => !hasDownstreamCoverage(config, node.id, index));
  if (uncovered.length === 0) {
    return nodes;
  }
  const usedIds = new Set(nodes.map((node) => node.id));
  const coverageNodeId = uniqueGeneratedId(
    "generated-coverage",
    usedIds,
    "generated-coverage"
  );
  return [
    ...nodes,
    {
      gates: generatedCoverageGates(coverageNodeId),
      id: coverageNodeId,
      kind: "agent",
      needs: uncovered.map((node) => node.id),
      profile: coverageProfileId,
    },
  ];
}

// A node requires downstream coverage when it implements work directly, or when
// it is a parallel containing implementation work. Coverage is attached at the
// parallel's own level (running after it completes), never inside it: parallel
// children execute concurrently and do not honor inter-sibling needs, so a
// coverage node placed among them would verify the implementation before it ran.
function nodeNeedsImplementationCoverage(
  config: PipelineConfig,
  node: WorkflowNode
): boolean {
  if (isImplementationNode(config, node)) {
    return true;
  }
  return (
    node.kind === "parallel" &&
    node.nodes.some((child) => nodeNeedsImplementationCoverage(config, child))
  );
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
