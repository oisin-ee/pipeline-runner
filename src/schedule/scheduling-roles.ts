import type { PipelineConfig, SchedulingRole } from "../config";

type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];

/**
 * Whether an agent node's profile declares the given scheduling role. Non-agent
 * nodes never carry scheduling roles. This is the single source of truth for the
 * implementation/coverage role policy used by schedule generation and
 * validation.
 */
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

export function isImplementationNode(
  config: PipelineConfig,
  node: WorkflowNode
): boolean {
  return hasSchedulingRole(config, node, "implementation");
}

export function isCoverageNode(
  config: PipelineConfig,
  node: WorkflowNode
): boolean {
  return hasSchedulingRole(config, node, "coverage");
}

/**
 * Whether a parallel child mutates the workspace, and therefore must not share a
 * worktree with sibling writers unless their results are integrated downstream
 * (a `drain-merge` builtin). Agent nodes are write-capable when their profile is
 * workspace-write; command nodes always are; a nested parallel is write-capable
 * when any descendant is. Single source of truth for both schedule normalization
 * (the drain-merge integration pass) and validation.
 */
export function isWriteCapableParallelChild(
  config: PipelineConfig,
  node: WorkflowNode
): boolean {
  if (node.kind === "command") {
    return true;
  }
  if (node.kind === "parallel") {
    return node.nodes.some((child) =>
      isWriteCapableParallelChild(config, child)
    );
  }
  if (node.kind === "agent") {
    return isWorkspaceWriteProfile(config, node.profile);
  }
  return false;
}

function isWorkspaceWriteProfile(
  config: PipelineConfig,
  profileId: string
): boolean {
  return config.profiles[profileId]?.filesystem?.mode === "workspace-write";
}
