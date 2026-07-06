import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PlannedWorkflowNode, WorkflowExecutionPlan } from "./planning/compile";
import { indexPlannedNodesById, resolveExecutableDependencyIds } from "./planning/dependency-refs";
import { terminalDependencyItems } from "./planning/graph";
import { mutableArray, nonEmptyMutableArray, parseStrictWithSchema, requiredString, struct } from "./schema-boundary";
import { uniqueStrings } from "./strings";

const argoExecutableTaskSchema = struct({
  dependencies: mutableArray(requiredString),
  nodeId: requiredString,
  taskName: requiredString,
  templateName: requiredString,
});

const argoExecutionGraphSchema = struct({
  tasks: nonEmptyMutableArray(argoExecutableTaskSchema),
  terminalNodeIds: mutableArray(requiredString),
  terminalTaskNames: mutableArray(requiredString),
  workflowId: requiredString,
});

export type ArgoExecutableTask = typeof argoExecutableTaskSchema.Type;
export type ArgoExecutionGraph = typeof argoExecutionGraphSchema.Type;

/**
 * Thrown when the Argo graph compiler encounters a node kind that cannot be
 * lowered to an Argo DAG task. Callers should surface this as a validation
 * failure before attempting a cluster submission.
 */
export class ArgoGraphCompilerError extends Schema.TaggedErrorClass<ArgoGraphCompilerError>()(
  "ArgoGraphCompilerError",
  {
    kind: Schema.String,
    message: Schema.String,
    nodeId: Schema.String,
  },
) {
  constructor(kind: string, nodeId: string) {
    super({
      kind,
      message: `Argo graph compiler: node kind '${kind}' on node '${nodeId}' cannot be lowered to an Argo DAG task`,
      nodeId,
    });
  }
}

class ArgoGraphDuplicateNodeError extends Schema.TaggedErrorClass<ArgoGraphDuplicateNodeError>()(
  "ArgoGraphDuplicateNodeError",
  {
    message: Schema.String,
    nodeId: Schema.String,
  },
) {
  constructor(nodeId: string) {
    super({
      message: `Argo schedule contains duplicate node id '${nodeId}'`,
      nodeId,
    });
  }
}

const argoTaskName = (nodeId: string): string => `node-${nodeId}`;

const argoTemplateName = (nodeId: string): string => `task-${nodeId}`;

interface DuplicateNodeSearchState {
  readonly duplicate: Option.Option<string>;
  readonly seen: HashMap.HashMap<string, true>;
}

interface ArgoGraphCompileContext {
  readonly nodeById: ReadonlyMap<string, PlannedWorkflowNode>;
}

interface CompileArgoNodeInput {
  readonly context: ArgoGraphCompileContext;
  readonly inheritedNeeds: readonly string[];
  readonly node: PlannedWorkflowNode;
  readonly tasks: ArgoExecutableTask[];
}

const emptyDuplicateNodeSearchState: DuplicateNodeSearchState = {
  duplicate: Option.none(),
  seen: HashMap.empty<string, true>(),
};

const nodeAndDescendants = (node: PlannedWorkflowNode): readonly PlannedWorkflowNode[] => [
  node,
  ...Arr.flatMap(node.children ?? [], nodeAndDescendants),
];

const plannedNodeTree = (nodes: readonly PlannedWorkflowNode[]): readonly PlannedWorkflowNode[] =>
  Arr.flatMap(nodes, nodeAndDescendants);

const trackDuplicateNodeId = (state: DuplicateNodeSearchState, node: PlannedWorkflowNode): DuplicateNodeSearchState =>
  Option.isSome(state.duplicate)
    ? state
    : HashMap.has(state.seen, node.id)
      ? { ...state, duplicate: Option.some(node.id) }
      : {
          duplicate: Option.none(),
          seen: HashMap.set(state.seen, node.id, true),
        };

const duplicateNodeId = (nodes: readonly PlannedWorkflowNode[]): Option.Option<string> =>
  Arr.reduce(plannedNodeTree(nodes), emptyDuplicateNodeSearchState, trackDuplicateNodeId).duplicate;

const assertUniqueNodeIds = (nodes: readonly PlannedWorkflowNode[]): void => {
  Option.match(duplicateNodeId(nodes), {
    onNone: () => undefined,
    onSome: (nodeId) => {
      throw new ArgoGraphDuplicateNodeError(nodeId);
    },
  });
};

const resolveDependencyTaskNames = (context: ArgoGraphCompileContext, nodeIds: readonly string[]): string[] =>
  uniqueStrings(resolveExecutableDependencyIds(context.nodeById, nodeIds).map((id) => argoTaskName(id)));

const compileExecutableNode = (
  context: ArgoGraphCompileContext,
  node: PlannedWorkflowNode,
  inheritedNeeds: readonly string[],
): ArgoExecutableTask => {
  const dependencies = resolveDependencyTaskNames(context, [...inheritedNeeds, ...node.needs]);
  return parseStrictWithSchema(argoExecutableTaskSchema, {
    dependencies,
    nodeId: node.id,
    taskName: argoTaskName(node.id),
    templateName: argoTemplateName(node.id),
  });
};

const compileArgoNodes = (
  context: ArgoGraphCompileContext,
  nodes: readonly PlannedWorkflowNode[],
  inheritedNeeds: readonly string[],
  initialTasks: ArgoExecutableTask[] = [],
): ArgoExecutableTask[] =>
  Arr.reduce(nodes, initialTasks, (tasks, node) => compileArgoNode({ context, inheritedNeeds, node, tasks }));

const compileArgoNode = (input: CompileArgoNodeInput): ArgoExecutableTask[] =>
  Match.value(input.node.kind).pipe(
    Match.whenOr("agent", "builtin", "command", () => [
      ...input.tasks,
      compileExecutableNode(input.context, input.node, input.inheritedNeeds),
    ]),
    Match.when("group", () => input.tasks),
    Match.when("parallel", () =>
      compileArgoNodes(
        input.context,
        input.node.children ?? [],
        [...input.inheritedNeeds, ...input.node.needs],
        input.tasks,
      ),
    ),
    Match.exhaustive,
  );

const compileArgoExecutionGraphUnchecked = (plan: WorkflowExecutionPlan): ArgoExecutionGraph => {
  const context: ArgoGraphCompileContext = {
    nodeById: indexPlannedNodesById(plan.topologicalOrder),
  };
  const tasks = compileArgoNodes(context, plan.topologicalOrder, []);
  const terminalTasks = terminalDependencyItems(
    tasks,
    (task) => task.taskName,
    (task) => task.dependencies,
  );
  return {
    tasks,
    terminalNodeIds: terminalTasks.map((task) => task.nodeId),
    terminalTaskNames: terminalTasks.map((task) => task.taskName),
    workflowId: plan.workflowId,
  };
};

export const compileArgoExecutionGraph = (plan: WorkflowExecutionPlan): ArgoExecutionGraph => {
  assertUniqueNodeIds(plan.topologicalOrder);
  return parseStrictWithSchema(argoExecutionGraphSchema, compileArgoExecutionGraphUnchecked(plan));
};
