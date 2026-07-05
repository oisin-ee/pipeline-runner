import { Data } from "effect";

import type { PipelineConfig, WorkflowNodeKind } from "../config";
import { uniqueStrings } from "../strings";
import {
  createDependencyGraph,
  dependencyBatches,
  dependencyGraphNodeIds,
  dependencyGraphValue,
  findDependencyCycles,
  successorIds,
  topologicalDependencyOrder,
} from "./graph";
import type { DependencyGraph } from "./graph";

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
    super({ code, issues, message });
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
  reasoning_effort?: WorkflowNode["reasoning_effort"];
  retries?: WorkflowNode["retries"];
  taskContext?: PlannedWorkflowTaskContext;
  timeoutMs?: number;
}

export interface PlannedWorkflowTaskContext {
  acceptanceCriteria?: { id: string; text: string }[];
  description?: string;
  id?: string;
  title?: string;
}

export interface WorkflowExecutionPlan {
  execution: PlannedWorkflowExecution;
  graph: DependencyGraph<PlannedWorkflowNode>;
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

const workflowExecution = (
  workflow: PipelineConfig["workflows"][string]
): PlannedWorkflowExecution => {
  const execution: PlannedWorkflowExecution = {
    failFast: workflow.execution?.fail_fast === true,
  };
  if (
    workflow.execution?.max_parallel_nodes !== undefined &&
    workflow.execution.max_parallel_nodes !== 0
  ) {
    execution.maxParallelNodes = workflow.execution.max_parallel_nodes;
  }
  if (
    workflow.execution?.timeout_ms !== undefined &&
    workflow.execution.timeout_ms !== 0
  ) {
    execution.timeoutMs = workflow.execution.timeout_ms;
  }
  return execution;
};

const duplicateNodeIssues = (
  workflowId: string,
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] => {
  const seen = new Set<string>();
  return nodes.flatMap((node) => {
    if (seen.has(node.id)) {
      return [
        {
          message: `workflow '${workflowId}' declares duplicate node id '${node.id}'`,
          path: `workflows.${workflowId}.nodes.${node.id}`,
        },
      ];
    }
    seen.add(node.id);
    return [];
  });
};

const dependencyIssues = (
  workflowId: string,
  nodes: WorkflowNode[],
  nodeIds: Set<string>
): WorkflowPlannerIssue[] =>
  nodes.flatMap((node) =>
    (node.needs ?? [])
      .filter((need) => !nodeIds.has(need))
      .map((need) => ({
        message: `node '${node.id}' references missing dependency '${need}'`,
        path: `workflows.${workflowId}.nodes.${node.id}.needs`,
      }))
  );

const emptyGroupIssues = (
  workflowId: string,
  node: GroupWorkflowNode
): WorkflowPlannerIssue[] => {
  if (node.nodes.length > 0) {
    return [];
  }
  return [
    {
      message: `group node '${node.id}' must reference at least one child node`,
      path: `workflows.${workflowId}.nodes.${node.id}.nodes`,
    },
  ];
};

const groupChildIssues = (
  workflowId: string,
  node: GroupWorkflowNode,
  nodeIds: Set<string>
): WorkflowPlannerIssue[] =>
  node.nodes.flatMap((childId) => {
    if (!nodeIds.has(childId)) {
      return [
        {
          message: `group node '${node.id}' references missing child node '${childId}'`,
          path: `workflows.${workflowId}.nodes.${node.id}.nodes`,
        },
      ];
    }
    if (childId === node.id) {
      return [
        {
          message: `group node '${node.id}' cannot reference itself`,
          path: `workflows.${workflowId}.nodes.${node.id}.nodes`,
        },
      ];
    }
    return [];
  });

const isGroupNode = (node: WorkflowNode): node is GroupWorkflowNode =>
  node.kind === "group";

const normalizeGroupDependencies = (nodes: WorkflowNode[]): WorkflowNode[] =>
  nodes.map((node) => {
    if (!isGroupNode(node)) {
      return node;
    }
    return {
      ...node,
      needs: uniqueStrings([...node.nodes, ...(node.needs ?? [])]),
    };
  });

const groupIssues = (
  workflowId: string,
  nodes: WorkflowNode[],
  nodeIds: Set<string>
): WorkflowPlannerIssue[] =>
  nodes
    .filter(isGroupNode)
    .flatMap((node) => [
      ...emptyGroupIssues(workflowId, node),
      ...groupChildIssues(workflowId, node, nodeIds),
    ]);

const cycleIssues = (
  workflowId: string,
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] =>
  findDependencyCycles(nodes).map((cycle) => {
    const id = cycle[0] ?? "nodes";
    return {
      message: `workflow '${workflowId}' contains dependency cycle: ${cycle.join(" -> ")}`,
      path: `workflows.${workflowId}.nodes.${id}.needs`,
    };
  });

const validateNodeGraph = (
  workflowId: string,
  nodes: WorkflowNode[]
): WorkflowPlannerIssue[] => {
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
};

const plannedNodeIndex = (
  nodesById: ReadonlyMap<string, PlannedWorkflowNode>,
  nodeId: string
): number => nodesById.get(nodeId)?.index ?? 0;

const plannedNodesForIds = (
  graph: DependencyGraph<PlannedWorkflowNode>,
  nodeIds: readonly string[]
): PlannedWorkflowNode[] =>
  nodeIds
    .map((nodeId) => dependencyGraphValue(graph, nodeId))
    .filter((node): node is PlannedWorkflowNode => node !== undefined);

const buildParallelBatches = (
  graph: DependencyGraph<PlannedWorkflowNode>,
  topologicalOrder: PlannedWorkflowNode[]
): PlannedWorkflowNode[][] => {
  const byId = new Map(topologicalOrder.map((node) => [node.id, node]));
  return dependencyBatches(
    graph,
    topologicalOrder.map((node) => node.id),
    (left, right) =>
      plannedNodeIndex(byId, left) - plannedNodeIndex(byId, right)
  ).map((batch) => plannedNodesForIds(graph, batch));
};

const agentNodeCategory = (node: WorkflowNode): string | void =>
  node.kind === "agent" ? node.category : undefined;

const plannedTaskContext = (
  taskContext: WorkflowNode["task_context"]
): PlannedWorkflowTaskContext | void => {
  if (taskContext === undefined) {
    return;
  }
  const planned: PlannedWorkflowTaskContext = {};
  if (taskContext.acceptance_criteria !== undefined) {
    planned.acceptanceCriteria = taskContext.acceptance_criteria.map(
      (criterion) => ({
        id: criterion.id,
        text: criterion.text,
      })
    );
  }
  if (
    taskContext.description !== undefined &&
    taskContext.description.length > 0
  ) {
    planned.description = taskContext.description;
  }
  if (taskContext.id !== undefined && taskContext.id.length > 0) {
    planned.id = taskContext.id;
  }
  if (taskContext.title !== undefined && taskContext.title.length > 0) {
    planned.title = taskContext.title;
  }
  return planned;
};

const toPlannedNode = (
  node: WorkflowNode,
  index: number
): PlannedWorkflowNode => {
  const category = agentNodeCategory(node);
  const taskContext = plannedTaskContext(node.task_context);
  const planned: PlannedWorkflowNode = {
    artifacts: node.artifacts,
    builtin: "builtin" in node ? node.builtin : undefined,
    ...(category === undefined ? {} : { category }),
    children:
      node.kind === "parallel"
        ? node.nodes.map((child, childIndex) =>
            toPlannedNode(child, childIndex)
          )
        : undefined,
    command: "command" in node ? node.command : undefined,
    dependents: [],
    gates: node.gates,
    id: node.id,
    index,
    kind: node.kind,
    models: node.models,
    needs: node.needs ?? [],
    nodes: node.kind === "group" ? node.nodes : undefined,
    profile: "profile" in node ? node.profile : undefined,
    reasoning_effort: node.reasoning_effort,
    retries: node.retries,
    ...(taskContext === undefined ? {} : { taskContext }),
  };
  if (node.timeout_ms !== undefined && node.timeout_ms !== 0) {
    planned.timeoutMs = node.timeout_ms;
  }
  return planned;
};

const createWorkflowGraph = (
  nodes: WorkflowNode[]
): DependencyGraph<PlannedWorkflowNode> => {
  const graph = createDependencyGraph(nodes, {
    dependenciesOf: (node) => node.needs,
    valueOf: (node, index) => toPlannedNode(node, index),
  });
  for (const nodeId of dependencyGraphNodeIds(graph)) {
    const planned = dependencyGraphValue(graph, nodeId);
    if (planned !== undefined) {
      planned.dependents = successorIds(graph, nodeId);
    }
  }
  return graph;
};

const codeForIssue = (message: string): WorkflowPlannerErrorCode => {
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
};

const issuesToError = (
  issues: WorkflowPlannerIssue[]
): WorkflowPlannerError => {
  const [first] = issues;
  const code = codeForIssue(first.message);
  return new WorkflowPlannerError(
    code,
    [
      "Invalid workflow plan:",
      ...issues.map((issue) =>
        issue.path !== undefined && issue.path.length > 0
          ? `- ${issue.path}: ${issue.message}`
          : `- ${issue.message}`
      ),
    ].join("\n"),
    issues
  );
};

export const compileWorkflowPlan = (
  config: PipelineConfig,
  workflowId = config.default_workflow
): WorkflowExecutionPlan => {
  if (!Object.hasOwn(config.workflows, workflowId)) {
    throw new WorkflowPlannerError(
      "WORKFLOW_MISSING_WORKFLOW",
      `workflow '${workflowId}' is not declared`,
      [{ message: "workflow is missing", path: `workflows.${workflowId}` }]
    );
  }
  const workflow = config.workflows[workflowId];

  const nodes = normalizeGroupDependencies(workflow.nodes);
  const issues = validateNodeGraph(workflowId, nodes);
  if (issues.length > 0) {
    throw issuesToError(issues);
  }

  const graph = createWorkflowGraph(nodes);
  /*
   * PIPE-66: workflow planner toposort still keeps @dagrejs/graphlib as
   * the graph model, but uses the iterative topological traversal owned by
   * planning/graph.ts instead of graphlib's recursive topsort because deep
   * generated chains can overflow the call stack.
   */
  const topologicalOrder = plannedNodesForIds(
    graph,
    topologicalDependencyOrder(graph)
  );
  const parallelBatches = buildParallelBatches(graph, topologicalOrder);

  return {
    execution: workflowExecution(workflow),
    graph,
    parallelBatches,
    topologicalOrder,
    workflowId,
  };
};
