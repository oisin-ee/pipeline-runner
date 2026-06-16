import { Graph } from "@dagrejs/graphlib";
import { Data } from "effect";
import type { PipelineConfig, WorkflowNodeKind } from "../config";
import { uniqueStrings } from "../strings";
import { findDependencyCycles } from "./graph";

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

export class WorkflowPlannerError extends Data.TaggedError(
  "WorkflowPlannerError"
)<{
  readonly code: WorkflowPlannerErrorCode;
  readonly message: string;
  readonly issues: WorkflowPlannerIssue[];
}> {
  constructor(
    code: WorkflowPlannerErrorCode,
    message: string,
    issues: WorkflowPlannerIssue[] = []
  ) {
    super({ code, message, issues });
  }
}

export interface PlannedWorkflowNode {
  artifacts?: WorkflowNode["artifacts"];
  builtin?: string;
  category?: string;
  children?: PlannedWorkflowNode[];
  command?: string[];
  dependents: string[];
  gates?: WorkflowNode["gates"];
  id: string;
  index: number;
  kind: WorkflowNodeKind;
  models?: string[];
  needs: string[];
  nodes?: string[];
  profile?: string;
  retries?: WorkflowNode["retries"];
  taskContext?: PlannedWorkflowTaskContext;
  timeoutMs?: number;
}

export interface PlannedWorkflowTaskContext {
  acceptanceCriteria?: Array<{ id: string; text: string }>;
  description?: string;
  id?: string;
  title?: string;
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
  const topologicalOrder = topologicalOrderForPlan(graph).map((nodeId) =>
    graph.node(nodeId)
  );
  const parallelBatches = buildParallelBatches(topologicalOrder);

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
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] {
  return findDependencyCycles(nodes).map((cycle) => {
    const id = cycle[0] ?? "nodes";
    return {
      path: `workflows.${workflowId}.nodes.${id}.needs`,
      message: `workflow '${workflowId}' contains dependency cycle: ${cycle.join(" -> ")}`,
    };
  });
}

function topologicalOrderForPlan(
  graph: Graph<undefined, PlannedWorkflowNode>
): string[] {
  /*
   * Keep @dagrejs/graphlib as the graph model, but do the topological sort
   * with this iterative traversal. graphlib's recursive topsort can hit call
   * stack overflow on deep generated workflow chains, while this preserves the
   * graphlib sink/predecessor ordering the planner tests cover.
   */
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const results: string[] = [];

  for (const sink of graph.sinks()) {
    visitForTopologicalOrder(sink, graph, visited, inStack, results);
  }

  if (visited.size !== graph.nodeCount()) {
    throw new Error("workflow graph contains a dependency cycle");
  }

  return results;
}

function visitForTopologicalOrder(
  startId: string,
  graph: Graph<undefined, PlannedWorkflowNode>,
  visited: Set<string>,
  inStack: Set<string>,
  results: string[]
): void {
  const frames: Array<{
    index: number;
    nodeId: string;
    predecessors: string[];
  }> = [];
  pushTopologicalFrame(startId, graph, visited, inStack, frames);

  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (!frame) {
      return;
    }
    const predecessorId = frame.predecessors[frame.index];
    if (!predecessorId) {
      inStack.delete(frame.nodeId);
      results.push(frame.nodeId);
      frames.pop();
      continue;
    }
    frame.index += 1;
    if (inStack.has(predecessorId)) {
      throw new Error("workflow graph contains a dependency cycle");
    }
    if (visited.has(predecessorId)) {
      continue;
    }
    pushTopologicalFrame(predecessorId, graph, visited, inStack, frames);
  }
}

function pushTopologicalFrame(
  nodeId: string,
  graph: Graph<undefined, PlannedWorkflowNode>,
  visited: Set<string>,
  inStack: Set<string>,
  frames: Array<{ index: number; nodeId: string; predecessors: string[] }>
): void {
  visited.add(nodeId);
  inStack.add(nodeId);
  frames.push({
    index: 0,
    nodeId,
    predecessors: graph.predecessors(nodeId) ?? [],
  });
}

function buildParallelBatches(
  topologicalOrder: PlannedWorkflowNode[]
): PlannedWorkflowNode[][] {
  const nodeIds = new Set(topologicalOrder.map((node) => node.id));
  const byId = new Map(topologicalOrder.map((node) => [node.id, node]));
  const remainingNeeds = new Map(
    topologicalOrder.map((node) => [
      node.id,
      uniqueExistingNeeds(node, nodeIds).length,
    ])
  );
  let ready = topologicalOrder.filter(
    (node) => (remainingNeeds.get(node.id) ?? 0) === 0
  );
  const batches: PlannedWorkflowNode[][] = [];

  while (ready.length > 0) {
    const batch = ready.sort((a, b) => a.index - b.index);
    batches.push(batch);
    ready = [];
    for (const node of batch) {
      for (const dependentId of node.dependents) {
        const remaining = (remainingNeeds.get(dependentId) ?? 0) - 1;
        remainingNeeds.set(dependentId, remaining);
        if (remaining === 0) {
          const dependent = byId.get(dependentId);
          if (dependent) {
            ready.push(dependent);
          }
        }
      }
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
  const dependentIds = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      if (nodeIds.has(need)) {
        graph.setEdge(need, node.id);
        const dependents = dependentIds.get(need) ?? new Set<string>();
        dependents.add(node.id);
        dependentIds.set(need, dependents);
      }
    }
  }
  for (const [nodeId, dependents] of dependentIds) {
    const planned = graph.node(nodeId);
    if (planned) {
      planned.dependents = [...dependents];
    }
  }
  return graph;
}

function uniqueExistingNeeds(
  node: PlannedWorkflowNode,
  nodeIds: Set<string>
): string[] {
  return uniqueStrings(node.needs.filter((need) => nodeIds.has(need)));
}

function agentNodeCategory(node: WorkflowNode): string | undefined {
  return node.kind === "agent" ? node.category : undefined;
}

function toPlannedNode(node: WorkflowNode, index: number): PlannedWorkflowNode {
  const planned: PlannedWorkflowNode = {
    artifacts: node.artifacts,
    builtin: "builtin" in node ? node.builtin : undefined,
    category: agentNodeCategory(node),
    command: "command" in node ? node.command : undefined,
    children:
      node.kind === "parallel"
        ? node.nodes.map((child, childIndex) =>
            toPlannedNode(child, childIndex)
          )
        : undefined,
    dependents: [],
    gates: node.gates,
    id: node.id,
    index,
    kind: node.kind,
    models: node.models,
    needs: node.needs ?? [],
    nodes: node.kind === "group" ? node.nodes : undefined,
    profile: "profile" in node ? node.profile : undefined,
    retries: node.retries,
    taskContext: plannedTaskContext(node.task_context),
  };
  if (node.timeout_ms) {
    planned.timeoutMs = node.timeout_ms;
  }
  return planned;
}

function plannedTaskContext(
  taskContext: WorkflowNode["task_context"]
): PlannedWorkflowTaskContext | undefined {
  if (!taskContext) {
    return;
  }
  const planned: PlannedWorkflowTaskContext = {};
  if (taskContext.acceptance_criteria) {
    planned.acceptanceCriteria = taskContext.acceptance_criteria.map(
      (criterion) => ({
        id: criterion.id,
        text: criterion.text,
      })
    );
  }
  if (taskContext.description) {
    planned.description = taskContext.description;
  }
  if (taskContext.id) {
    planned.id = taskContext.id;
  }
  if (taskContext.title) {
    planned.title = taskContext.title;
  }
  return planned;
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
