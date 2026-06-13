import type { PipelineConfig } from "../../config";
import type {
  ScheduleArtifact,
  ScheduleArtifactError,
} from "../../planning/generate";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

export function namespaceScheduleWorkflows(
  artifact: ScheduleArtifact,
  ErrorCtor: typeof ScheduleArtifactError
): { scheduledWorkflows: ScheduleArtifact["workflows"]; workflowId: string } {
  const workflowIds = Object.keys(artifact.workflows);
  const mappedIds = new Map(
    workflowIds.map((id) => [id, scheduleWorkflowId(artifact.schedule_id, id)])
  );
  const scheduledWorkflows = Object.fromEntries(
    Object.entries(artifact.workflows).map(([id, workflow]) => [
      mappedIds.get(id) ?? id,
      rewriteWorkflowReferences(workflow, mappedIds, ErrorCtor),
    ])
  );
  const workflowId = mappedIds.get(artifact.root_workflow);
  if (!workflowId) {
    throw new ErrorCtor(
      `schedule root workflow '${artifact.root_workflow}' is not declared`
    );
  }
  return { scheduledWorkflows, workflowId };
}

function scheduleWorkflowId(scheduleId: string, workflowId: string): string {
  return `schedule-${scheduleId}-${workflowId}`;
}

function rewriteWorkflowReferences(
  workflow: Workflow,
  mappedIds: Map<string, string>,
  ErrorCtor: typeof ScheduleArtifactError
): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      rewriteNodeReferences(node, mappedIds, ErrorCtor)
    ),
  };
}

function rewriteNodeReferences(
  node: WorkflowNode,
  mappedIds: Map<string, string>,
  ErrorCtor: typeof ScheduleArtifactError
): WorkflowNode {
  if (node.kind === "parallel") {
    if (!Array.isArray(node.nodes)) {
      throw new ErrorCtor(
        `schedule parallel node '${node.id}' is missing child nodes`
      );
    }
    return {
      ...node,
      nodes: node.nodes.map((child) =>
        rewriteNodeReferences(child, mappedIds, ErrorCtor)
      ),
    };
  }
  return node;
}
