import { alg, Graph } from "@dagrejs/graphlib";
import type { PipelineConfig, WorkflowNodeKind } from "./config.js";

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
  profile?: string;
  retries?: WorkflowNode["retries"];
  timeoutMs?: number;
}

export interface WorkflowExecutionPlan {
  execution: PlannedWorkflowExecution;
  graph: Graph<undefined, PlannedWorkflowNode>;
  parallelBatches: PlannedWorkflowNode[][];
  topologicalOrder: PlannedWorkflowNode[];
  workflowId: string;
}

export interface PlannedWorkflowExecution {
  failFast: boolean;
  maxParallelNodes?: number;
  timeoutMs?: number;
}

type WorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];
type GroupWorkflowNode = Extract<WorkflowNode, { kind: "group" }>;

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

  const nodes = normalizeGroupDependencies(workflow.nodes);
  const issues = validateNodeGraph(workflowId, nodes);
  if (issues.length > 0) {
    throw issuesToError(issues);
  }

  const graph = createWorkflowGraph(nodes);
  const topologicalOrder = alg
    .topsort(graph)
    .map((nodeId) => graph.node(nodeId));
  const parallelBatches = buildParallelBatches(topologicalOrder, graph);

  return {
    execution: workflowExecution(workflow),
    graph,
    parallelBatches,
    topologicalOrder,
    workflowId,
  };
}

function workflowExecution(
  workflow: PipelineConfig["workflows"][string]
): PlannedWorkflowExecution {
  const execution: PlannedWorkflowExecution = {
    failFast: workflow.execution?.fail_fast === true,
  };
  if (workflow.execution?.max_parallel_nodes) {
    execution.maxParallelNodes = workflow.execution.max_parallel_nodes;
  }
  if (workflow.execution?.timeout_ms) {
    execution.timeoutMs = workflow.execution.timeout_ms;
  }
  return execution;
}

function normalizeGroupDependencies(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.map((node) => {
    if (!isGroupNode(node)) {
      return node;
    }
    return {
      ...node,
      needs: uniqueStrings([...(node.nodes ?? []), ...(node.needs ?? [])]),
    };
  });
}

function validateNodeGraph(
  workflowId: string,
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] {
  const duplicateIssues = duplicateNodeIssues(workflowId, nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const issues = [
    ...duplicateIssues,
    ...groupIssues(workflowId, nodes, nodeIds),
    ...dependencyIssues(workflowId, nodes, nodeIds),
  ];
  if (duplicateIssues.length === 0) {
    return [...issues, ...cycleIssues(workflowId, nodes, nodeIds)];
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
    .filter(isGroupNode)
    .flatMap((node) => [
      ...emptyGroupIssues(workflowId, node),
      ...groupChildIssues(workflowId, node, nodeIds),
    ]);
}

function emptyGroupIssues(
  workflowId: string,
  node: GroupWorkflowNode
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
  node: GroupWorkflowNode,
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

function isGroupNode(node: WorkflowNode): node is GroupWorkflowNode {
  return node.kind === "group";
}

function cycleIssues(
  workflowId: string,
  nodes: WorkflowNode[],
  nodeIds: Set<string>
): WorkflowPlannerIssue[] {
  const graph = createWorkflowGraph(nodes, nodeIds);
  return alg.findCycles(graph).map((cycle) => {
    const id = cycle[0] ?? "nodes";
    return {
      path: `workflows.${workflowId}.nodes.${id}.needs`,
      message: `workflow '${workflowId}' contains dependency cycle: ${cycle.join(" -> ")}`,
    };
  });
}

function buildParallelBatches(
  topologicalOrder: PlannedWorkflowNode[],
  graph: Graph<undefined, PlannedWorkflowNode>
): PlannedWorkflowNode[][] {
  const completed = new Set<string>();
  const remaining = [...topologicalOrder];
  const batches: PlannedWorkflowNode[][] = [];

  while (remaining.length > 0) {
    const batch = remaining.filter((node) =>
      (graph.predecessors(node.id) ?? []).every((need) => completed.has(need))
    );
    batch.sort((a, b) => a.index - b.index);
    batches.push(batch);
    for (const node of batch) {
      completed.add(node.id);
      remaining.splice(remaining.indexOf(node), 1);
    }
  }

  return batches;
}

function createWorkflowGraph(
  nodes: WorkflowNode[],
  nodeIds = new Set(nodes.map((node) => node.id))
): Graph<undefined, PlannedWorkflowNode> {
  const graph = new Graph<undefined, PlannedWorkflowNode>({ directed: true });
  for (const [index, node] of nodes.entries()) {
    graph.setNode(node.id, toPlannedNode(node, index));
  }
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      if (nodeIds.has(need)) {
        graph.setEdge(need, node.id);
      }
    }
  }
  for (const node of graph.nodes()) {
    const planned = graph.node(node);
    planned.dependents = graph.successors(node) ?? [];
  }
  return graph;
}

function toPlannedNode(node: WorkflowNode, index: number): PlannedWorkflowNode {
  const planned: PlannedWorkflowNode = {
    artifacts: node.artifacts,
    builtin: "builtin" in node ? node.builtin : undefined,
    command: "command" in node ? node.command : undefined,
    dependents: [],
    gates: node.gates,
    hooks: node.hooks,
    id: node.id,
    index,
    kind: node.kind,
    needs: node.needs ?? [],
    nodes: "nodes" in node ? node.nodes : undefined,
    profile: "profile" in node ? node.profile : undefined,
    retries: node.retries,
  };
  if (node.timeout_ms) {
    planned.timeoutMs = node.timeout_ms;
  }
  return planned;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
