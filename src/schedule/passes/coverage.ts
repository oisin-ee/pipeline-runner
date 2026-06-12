import type { PipelineConfig, SchedulingRole } from "../../config";
import type { ScheduleArtifact } from "../planner";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

const DEFAULT_GENERATED_COVERAGE_PROFILE_PREFERENCE = [
  "moka-verifier",
  "moka-acceptance-reviewer",
  "moka-thermo-nuclear-reviewer",
];
const GENERATED_ID_INVALID_CHARS_RE = /[^a-z0-9]+/g;
const GENERATED_ID_TRIM_HYPHENS_RE = /^-+|-+$/g;
const STARTS_WITH_ALPHA_RE = /^[a-z]/;

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
  const dependentsByNeed = workflowDependentsByNeed(scopedNodes);
  const uncovered = scopedNodes
    .filter((node) => isImplementationNode(config, node))
    .filter(
      (node) => !hasDownstreamCoverage(config, node.id, dependentsByNeed)
    );
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

function workflowDependentsByNeed(
  nodes: WorkflowNode[]
): Map<string, WorkflowNode[]> {
  const dependentsByNeed = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      const dependents = dependentsByNeed.get(need) ?? [];
      dependents.push(node);
      dependentsByNeed.set(need, dependents);
    }
  }
  return dependentsByNeed;
}

function isImplementationNode(
  config: PipelineConfig,
  node: WorkflowNode
): boolean {
  return hasSchedulingRole(config, node, "implementation");
}

function hasDownstreamCoverage(
  config: PipelineConfig,
  nodeId: string,
  dependentsByNeed: Map<string, WorkflowNode[]>
): boolean {
  return hasReachableDependent(nodeId, dependentsByNeed, (node) =>
    hasSchedulingRole(config, node, "coverage")
  );
}

function hasSchedulingRole(
  config: PipelineConfig,
  node: WorkflowNode,
  role: SchedulingRole
): boolean {
  if (node.kind !== "agent") {
    return false;
  }
  const profile = config.profiles[node.profile];
  return profile?.scheduling_roles?.includes(role) ?? false;
}

function hasReachableDependent(
  nodeId: string,
  dependentsByNeed: Map<string, WorkflowNode[]>,
  matches: (node: WorkflowNode) => boolean
): boolean {
  const visited = new Set<string>();
  const queue = [...(dependentsByNeed.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || visited.has(node.id)) {
      continue;
    }
    visited.add(node.id);
    if (matches(node)) {
      return true;
    }
    queue.push(...(dependentsByNeed.get(node.id) ?? []));
  }
  return false;
}

function uniqueGeneratedId(
  value: string,
  usedIds: Set<string>,
  fallbackPrefix: string
): string {
  const base = generatedId(value, fallbackPrefix);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function generatedId(value: string, fallbackPrefix: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(GENERATED_ID_INVALID_CHARS_RE, "-")
    .replaceAll(GENERATED_ID_TRIM_HYPHENS_RE, "");
  if (STARTS_WITH_ALPHA_RE.test(slug)) {
    return slug;
  }
  return slug ? `${fallbackPrefix}-${slug}` : fallbackPrefix;
}
