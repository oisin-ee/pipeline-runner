import type { PipelineConfig, WorkflowNodeKind } from "./mastra/config.js";

export type WorkflowPlannerErrorCode =
  | "WORKFLOW_CYCLE"
  | "WORKFLOW_DUPLICATE_NODE"
  | "WORKFLOW_GROUP_REFERENCE"
  | "WORKFLOW_MISSING_DEPENDENCY"
  | "WORKFLOW_MISSING_WORKFLOW";

export interface WorkflowPlannerIssue {
  message: string;
  path?: string;
}

export class WorkflowPlannerError extends Error {
  code: WorkflowPlannerErrorCode;
  issues: WorkflowPlannerIssue[];

  constructor(
    code: WorkflowPlannerErrorCode,
    message: string,
    issues: WorkflowPlannerIssue[] = []
  ) {
    super(message);
    this.name = "WorkflowPlannerError";
    this.code = code;
    this.issues = issues;
  }
}

export interface PlannedWorkflowNode {
  agent?: string;
  artifacts?: WorkflowNode["artifacts"];
  builtin?: string;
  command?: string[];
  dependents: string[];
  gates?: WorkflowNode["gates"];
  hooks?: string[];
  id: string;
  index: number;
  kind: WorkflowNodeKind;
  needs: string[];
  nodes?: string[];
  retries?: WorkflowNode["retries"];
}

export interface WorkflowExecutionPlan {
  parallelBatches: PlannedWorkflowNode[][];
  topologicalOrder: PlannedWorkflowNode[];
  workflowId: string;
}

type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];

export function compileWorkflowPlan(
  config: PipelineConfig,
  workflowId = config.default_workflow
): WorkflowExecutionPlan {
  const workflow = config.workflows[workflowId];
  if (!workflow) {
    throw new WorkflowPlannerError(
      "WORKFLOW_MISSING_WORKFLOW",
      `workflow '${workflowId}' is not declared`,
      [{ path: `workflows.${workflowId}`, message: "workflow is missing" }]
    );
  }

  const nodes = workflow.nodes;
  const issues = validateNodeGraph(workflowId, nodes);
  if (issues.length > 0) {
    throw issuesToError(issues);
  }

  const plannedNodes = nodes.map((node, index) =>
    toPlannedNode(node, index, dependentsFor(node.id, nodes))
  );
  const byId = new Map(plannedNodes.map((node) => [node.id, node]));
  const topologicalOrder = topologicalSort(workflowId, plannedNodes);
  const parallelBatches = buildParallelBatches(topologicalOrder, byId);

  return {
    parallelBatches,
    topologicalOrder,
    workflowId,
  };
}

function validateNodeGraph(
  workflowId: string,
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] {
  const duplicateIssues = duplicateNodeIssues(workflowId, nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const issues = [
    ...duplicateIssues,
    ...dependencyIssues(workflowId, nodes, nodeIds),
    ...groupIssues(workflowId, nodes, nodeIds),
  ];
  if (duplicateIssues.length === 0) {
    return [...issues, ...cycleIssues(workflowId, nodes)];
  }
  return issues;
}

function duplicateNodeIssues(
  workflowId: string,
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] {
  const seen = new Set<string>();
  return nodes.flatMap((node) => {
    if (seen.has(node.id)) {
      return [
        {
          path: `workflows.${workflowId}.nodes.${node.id}`,
          message: `workflow '${workflowId}' declares duplicate node id '${node.id}'`,
        },
      ];
    }
    seen.add(node.id);
    return [];
  });
}

function dependencyIssues(
  workflowId: string,
  nodes: WorkflowNode[],
  nodeIds: Set<string>
): WorkflowPlannerIssue[] {
  return nodes.flatMap((node) =>
    (node.needs ?? [])
      .filter((need) => !nodeIds.has(need))
      .map((need) => ({
        path: `workflows.${workflowId}.nodes.${node.id}.needs`,
        message: `node '${node.id}' references missing dependency '${need}'`,
      }))
  );
}

function groupIssues(
  workflowId: string,
  nodes: WorkflowNode[],
  nodeIds: Set<string>
): WorkflowPlannerIssue[] {
  return nodes
    .filter((node) => node.kind === "group")
    .flatMap((node) => [
      ...emptyGroupIssues(workflowId, node),
      ...groupChildIssues(workflowId, node, nodeIds),
    ]);
}

function emptyGroupIssues(
  workflowId: string,
  node: WorkflowNode
): WorkflowPlannerIssue[] {
  if ((node.nodes ?? []).length > 0) {
    return [];
  }
  return [
    {
      path: `workflows.${workflowId}.nodes.${node.id}.nodes`,
      message: `group node '${node.id}' must reference at least one child node`,
    },
  ];
}

function groupChildIssues(
  workflowId: string,
  node: WorkflowNode,
  nodeIds: Set<string>
): WorkflowPlannerIssue[] {
  return (node.nodes ?? []).flatMap((childId) => {
    if (!nodeIds.has(childId)) {
      return [
        {
          path: `workflows.${workflowId}.nodes.${node.id}.nodes`,
          message: `group node '${node.id}' references missing child node '${childId}'`,
        },
      ];
    }
    if (childId === node.id) {
      return [
        {
          path: `workflows.${workflowId}.nodes.${node.id}.nodes`,
          message: `group node '${node.id}' cannot reference itself`,
        },
      ];
    }
    return [];
  });
}

function cycleIssues(
  workflowId: string,
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: WorkflowPlannerIssue[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      cycles.push({
        path: `workflows.${workflowId}.nodes.${id}.needs`,
        message: `workflow '${workflowId}' contains dependency cycle: ${cycle.join(" -> ")}`,
      });
      return;
    }

    visiting.add(id);
    stack.push(id);
    const node = byId.get(id);
    for (const need of node?.needs ?? []) {
      if (byId.has(need)) {
        visit(need);
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const node of nodes) {
    visit(node.id);
  }
  return cycles;
}

function topologicalSort(
  workflowId: string,
  nodes: PlannedWorkflowNode[]
): PlannedWorkflowNode[] {
  const remainingNeeds = new Map(
    nodes.map((node) => [node.id, new Set(node.needs)])
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered: PlannedWorkflowNode[] = [];

  while (ordered.length < nodes.length) {
    const ready = nodes.filter(
      (node) =>
        !ordered.includes(node) &&
        (remainingNeeds.get(node.id)?.size ?? 0) === 0
    );
    if (ready.length === 0) {
      throw new WorkflowPlannerError(
        "WORKFLOW_CYCLE",
        `workflow '${workflowId}' contains a dependency cycle`,
        [
          {
            path: `workflows.${workflowId}.nodes`,
            message: "no executable node remains",
          },
        ]
      );
    }

    ready.sort((a, b) => a.index - b.index);
    const next = ready[0] as PlannedWorkflowNode;
    ordered.push(next);
    for (const dependentId of next.dependents) {
      remainingNeeds.get(dependentId)?.delete(next.id);
    }
  }

  return ordered.map((node) => byId.get(node.id) as PlannedWorkflowNode);
}

function buildParallelBatches(
  topologicalOrder: PlannedWorkflowNode[],
  byId: Map<string, PlannedWorkflowNode>
): PlannedWorkflowNode[][] {
  const completed = new Set<string>();
  const remaining = [...topologicalOrder];
  const batches: PlannedWorkflowNode[][] = [];

  while (remaining.length > 0) {
    const batch = remaining.filter((node) =>
      node.needs.every((need) => completed.has(need))
    );
    batch.sort((a, b) => a.index - b.index);
    batches.push(batch.map((node) => byId.get(node.id) as PlannedWorkflowNode));
    for (const node of batch) {
      completed.add(node.id);
      remaining.splice(remaining.indexOf(node), 1);
    }
  }

  return batches;
}

function dependentsFor(id: string, nodes: WorkflowNode[]): string[] {
  return nodes
    .filter((node) => (node.needs ?? []).includes(id))
    .map((node) => node.id);
}

function toPlannedNode(
  node: WorkflowNode,
  index: number,
  dependents: string[]
): PlannedWorkflowNode {
  return {
    agent: node.agent,
    artifacts: node.artifacts,
    builtin: node.builtin,
    command: node.command,
    dependents,
    gates: node.gates,
    hooks: node.hooks,
    id: node.id,
    index,
    kind: node.kind,
    needs: node.needs ?? [],
    nodes: node.nodes,
    retries: node.retries,
  };
}

function issuesToError(issues: WorkflowPlannerIssue[]): WorkflowPlannerError {
  const first = issues[0];
  const code = codeForIssue(first?.message ?? "");
  return new WorkflowPlannerError(
    code,
    [
      "Invalid workflow plan:",
      ...issues.map((issue) =>
        issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`
      ),
    ].join("\n"),
    issues
  );
}

function codeForIssue(message: string): WorkflowPlannerErrorCode {
  if (message.includes("duplicate node id")) {
    return "WORKFLOW_DUPLICATE_NODE";
  }
  if (message.includes("missing dependency")) {
    return "WORKFLOW_MISSING_DEPENDENCY";
  }
  if (message.includes("group node")) {
    return "WORKFLOW_GROUP_REFERENCE";
  }
  if (message.includes("cycle")) {
    return "WORKFLOW_CYCLE";
  }
  return "WORKFLOW_MISSING_DEPENDENCY";
}
