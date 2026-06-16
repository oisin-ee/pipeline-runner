import { Data } from "effect";
import { z } from "zod";
import type { WorkflowNodeKind } from "./config";
import type {
  PlannedWorkflowNode,
  WorkflowExecutionPlan,
} from "./planning/compile";
import { uniqueStrings } from "./strings";

const argoExecutableTaskSchema = z
  .object({
    dependencies: z.array(z.string().min(1)),
    nodeId: z.string().min(1),
    taskName: z.string().min(1),
    templateName: z.string().min(1),
  })
  .strict();

const argoExecutionGraphSchema = z
  .object({
    terminalNodeIds: z.array(z.string().min(1)),
    tasks: z.array(argoExecutableTaskSchema).min(1),
    terminalTaskNames: z.array(z.string().min(1)),
    workflowId: z.string().min(1),
  })
  .strict();

export type ArgoExecutableTask = z.infer<typeof argoExecutableTaskSchema>;
export type ArgoExecutionGraph = z.infer<typeof argoExecutionGraphSchema>;

/**
 * Thrown when the Argo graph compiler encounters a node kind that cannot be
 * lowered to an Argo DAG task. Callers should surface this as a validation
 * failure before attempting a cluster submission.
 */
export class ArgoGraphCompilerError extends Data.TaggedError(
  "ArgoGraphCompilerError"
)<{
  readonly kind: string;
  readonly nodeId: string;
  readonly message: string;
}> {
  constructor(kind: string, nodeId: string) {
    super({
      kind,
      nodeId,
      message: `Argo graph compiler: node kind '${kind}' on node '${nodeId}' cannot be lowered to an Argo DAG task`,
    });
  }
}

export function compileArgoExecutionGraph(
  plan: WorkflowExecutionPlan
): ArgoExecutionGraph {
  const compiler = new ArgoGraphCompiler(plan);
  return argoExecutionGraphSchema.parse(compiler.compile());
}

class ArgoGraphCompiler {
  private readonly nodeById = new Map<string, PlannedWorkflowNode>();
  private readonly plan: WorkflowExecutionPlan;
  private readonly tasks: ArgoExecutableTask[] = [];

  constructor(plan: WorkflowExecutionPlan) {
    this.plan = plan;
    this.indexNodes(plan.topologicalOrder);
  }

  compile(): ArgoExecutionGraph {
    this.compileNodes(this.plan.topologicalOrder, []);
    return {
      terminalNodeIds: this.terminalTasks().map((task) => task.nodeId),
      tasks: this.tasks,
      terminalTaskNames: this.terminalTasks().map((task) => task.taskName),
      workflowId: this.plan.workflowId,
    };
  }

  private indexNodes(nodes: PlannedWorkflowNode[]): void {
    for (const node of nodes) {
      if (this.nodeById.has(node.id)) {
        throw new Error(
          `Argo schedule contains duplicate node id '${node.id}'`
        );
      }
      this.nodeById.set(node.id, node);
      this.indexNodes(node.children ?? []);
    }
  }

  private compileNodes(
    nodes: PlannedWorkflowNode[],
    inheritedNeeds: string[]
  ): void {
    for (const node of nodes) {
      this.compileNode(node, inheritedNeeds);
    }
  }

  // fallow-ignore-next-line complexity
  private compileNode(
    node: PlannedWorkflowNode,
    inheritedNeeds: string[]
  ): void {
    /*
     * Exhaustiveness guard: if a new kind is added to WorkflowNodeKind the
     * `default` branch will produce a compile error (TypeScript narrows `kind`
     * to `never`), preventing silent drops in the Argo lowering path.
     */
    const kind: WorkflowNodeKind = node.kind;
    switch (kind) {
      case "agent":
      case "builtin":
      case "command":
        this.compileExecutableNode(node, inheritedNeeds);
        return;
      case "group":
        /*
         * Group nodes are structural dependency anchors. They produce no Argo
         * task; their members are resolved by resolveDependencyNodeIds when a
         * downstream node lists the group in its needs.
         */
        return;
      case "parallel":
        this.compileParallelNode(node, inheritedNeeds);
        return;
      default: {
        const exhaustive: never = kind;
        throw new ArgoGraphCompilerError(String(exhaustive), node.id);
      }
    }
  }

  private compileExecutableNode(
    node: PlannedWorkflowNode,
    inheritedNeeds: string[]
  ): void {
    /*
     * Executable nodes (agent, builtin, command) lower directly to Argo DAG
     * tasks. The runner recovers per-node context (agent profile, models,
     * instructions) at execution time by loading the schedule artifact and
     * looking up the node by id. The task descriptor stored in the ConfigMap
     * therefore needs only the nodeId — it is intentionally minimal.
     */
    const dependencies = this.resolveDependencyTaskNames([
      ...inheritedNeeds,
      ...node.needs,
    ]);
    const task = argoExecutableTaskSchema.parse({
      dependencies,
      nodeId: node.id,
      taskName: argoTaskName(node.id),
      templateName: argoTemplateName(node.id),
    });
    this.tasks.push(task);
  }

  private compileParallelNode(
    node: PlannedWorkflowNode,
    inheritedNeeds: string[]
  ): void {
    /*
     * Parallel nodes are containers: their children run concurrently. Each
     * child inherits the parallel node's own needs (and any needs already
     * inherited from an enclosing context) so that the children are blocked by
     * the same upstream gates as the container itself.
     */
    this.compileNodes(node.children ?? [], [...inheritedNeeds, ...node.needs]);
  }

  private resolveDependencyTaskNames(nodeIds: string[]): string[] {
    return uniqueStrings(
      nodeIds.flatMap((nodeId) =>
        this.resolveDependencyNodeIds(nodeId).map((id) => argoTaskName(id))
      )
    );
  }

  // fallow-ignore-next-line complexity
  private resolveDependencyNodeIds(nodeId: string): string[] {
    const node = this.nodeById.get(nodeId);
    if (!node) {
      return [];
    }
    const kind: WorkflowNodeKind = node.kind;
    switch (kind) {
      case "agent":
      case "builtin":
      case "command":
        /*
         * Executable nodes resolve to themselves: a downstream Argo task that
         * needs this node will list its Argo task name as a dependency.
         */
        return [node.id];
      case "group":
        return this.resolveGroupNodeIds(node);
      case "parallel":
        return this.resolveParallelNodeIds(node);
      default: {
        const exhaustive: never = kind;
        throw new ArgoGraphCompilerError(String(exhaustive), node.id);
      }
    }
  }

  private resolveGroupNodeIds(node: PlannedWorkflowNode): string[] {
    /*
     * Groups are transparent dependency anchors: rewire through to the
     * group's member nodes and any nodes the group itself depends on.
     *
     * Example: group G contains [A, B]. Node C needs [G].
     * After lowering: C depends on [A, B] in the Argo DAG.
     *
     * This is correct because Argo requires concrete task names in dependency
     * arrays; virtual group names are not valid there.
     */
    return uniqueStrings(
      [...(node.nodes ?? []), ...node.needs].flatMap((id) =>
        this.resolveDependencyNodeIds(id)
      )
    );
  }

  private resolveParallelNodeIds(node: PlannedWorkflowNode): string[] {
    /*
     * Parallel containers are transparent: a downstream node that needs a
     * parallel container depends on all of the parallel's children.
     */
    return uniqueStrings(
      (node.children ?? []).flatMap((child) =>
        this.resolveDependencyNodeIds(child.id)
      )
    );
  }

  private terminalTasks(): ArgoExecutableTask[] {
    const dependedOn = new Set(this.tasks.flatMap((task) => task.dependencies));
    return this.tasks.filter((task) => !dependedOn.has(task.taskName));
  }
}

function argoTaskName(nodeId: string): string {
  return `node-${nodeId}`;
}

function argoTemplateName(nodeId: string): string {
  return `task-${nodeId}`;
}
