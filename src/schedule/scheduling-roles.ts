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
