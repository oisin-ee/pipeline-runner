import { z } from "zod";
import type {
  PlannedWorkflowNode,
  WorkflowExecutionPlan,
} from "./workflow-planner";

const EXECUTABLE_NODE_KINDS = ["agent", "builtin", "command"] as const;

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
      if (isExecutableNode(node)) {
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
        continue;
      }
      if (node.kind === "group") {
        continue;
      }
      if (node.kind === "parallel") {
        this.compileNodes(node.children ?? [], [
          ...inheritedNeeds,
          ...node.needs,
        ]);
      }
    }
  }

  private resolveDependencyTaskNames(nodeIds: string[]): string[] {
    return unique(
      nodeIds.flatMap((nodeId) =>
        this.resolveDependencyNodeIds(nodeId).map((id) => argoTaskName(id))
      )
    );
  }

  private resolveDependencyNodeIds(nodeId: string): string[] {
    const node = this.nodeById.get(nodeId);
    if (!node) {
      return [];
    }
    if (isExecutableNode(node)) {
      return [node.id];
    }
    if (node.kind === "group") {
      return unique(
        [...(node.nodes ?? []), ...node.needs].flatMap((id) =>
          this.resolveDependencyNodeIds(id)
        )
      );
    }
    if (node.kind === "parallel") {
      return unique(
        (node.children ?? []).flatMap((child) =>
          this.resolveDependencyNodeIds(child.id)
        )
      );
    }
    return [];
  }

  private terminalTasks(): ArgoExecutableTask[] {
    const dependedOn = new Set(this.tasks.flatMap((task) => task.dependencies));
    return this.tasks.filter((task) => !dependedOn.has(task.taskName));
  }
}

function isExecutableNode(node: PlannedWorkflowNode): boolean {
  return EXECUTABLE_NODE_KINDS.includes(
    node.kind as (typeof EXECUTABLE_NODE_KINDS)[number]
  );
}

function argoTaskName(nodeId: string): string {
  return `node-${nodeId}`;
}

function argoTemplateName(nodeId: string): string {
  return `task-${nodeId}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
