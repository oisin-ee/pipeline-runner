import type { BacklogTaskRecord } from "./backlog-task-store";
import {
  compareTaskIds,
  predecessorIds,
  scopedTicketIds,
  type TicketGraph,
} from "./ticket-graph";

const PRIORITY_RANK = {
  high: 0,
  medium: 1,
  low: 2,
} as const;

export type TicketSelectionStrategy = "bfs" | "dfs" | "priority";

export interface TicketSelectionOptions {
  readonly includeParents?: boolean;
  readonly rootId?: string;
  readonly strategy?: TicketSelectionStrategy;
}

export function selectReadyTickets(
  graph: TicketGraph,
  options: TicketSelectionOptions = {}
): BacklogTaskRecord[] {
  const ready = scopedTicketIds(graph, options.rootId)
    .map((id) => graph.tasksById.get(id))
    .filter((task): task is BacklogTaskRecord => task !== undefined)
    .filter((task) => isReadyTicket(graph, task, options));

  if (options.strategy === "bfs" || options.strategy === "dfs") {
    return orderByTraversal(graph, ready, options);
  }
  return ready.sort(compareReadyTickets);
}

export function selectNextTicket(
  graph: TicketGraph,
  options: TicketSelectionOptions = {}
): BacklogTaskRecord | undefined {
  return selectReadyTickets(graph, options)[0];
}

function isReadyTicket(
  graph: TicketGraph,
  task: BacklogTaskRecord,
  options: TicketSelectionOptions
): boolean {
  return (
    task.status === "To Do" &&
    (options.includeParents === true ||
      !hasIncompleteChildren(graph, task.id)) &&
    predecessorIds(graph, task.id).every(
      (dependencyId) => graph.tasksById.get(dependencyId)?.status === "Done"
    )
  );
}

function hasIncompleteChildren(graph: TicketGraph, taskId: string): boolean {
  return (graph.childrenByParentId.get(taskId) ?? []).some(
    (child) => child.status !== "Done"
  );
}

function orderByTraversal(
  graph: TicketGraph,
  ready: readonly BacklogTaskRecord[],
  options: TicketSelectionOptions
): BacklogTaskRecord[] {
  const remaining = new Map(ready.map((task) => [task.id, task]));
  const ordered: BacklogTaskRecord[] = [];
  for (const id of traversalIds(graph, options.rootId, options.strategy)) {
    const task = remaining.get(id);
    if (task) {
      ordered.push(task);
      remaining.delete(id);
    }
  }
  return [...ordered, ...[...remaining.values()].sort(compareReadyTickets)];
}

function traversalIds(
  graph: TicketGraph,
  rootId: string | undefined,
  strategy: TicketSelectionStrategy | undefined
): string[] {
  const roots = rootId ? [rootId] : rootIds(graph);
  return strategy === "dfs" ? dfsIds(graph, roots) : bfsIds(graph, roots);
}

function rootIds(graph: TicketGraph): string[] {
  return scopedTicketIds(graph)
    .filter((id) => !graph.tasksById.get(id)?.parentTaskId)
    .sort(compareTaskIds);
}

function bfsIds(graph: TicketGraph, roots: readonly string[]): string[] {
  const result: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) {
      continue;
    }
    result.push(id);
    queue.push(...childIds(graph, id));
  }
  return result;
}

function dfsIds(graph: TicketGraph, roots: readonly string[]): string[] {
  const result: string[] = [];
  const visit = (id: string): void => {
    result.push(id);
    for (const childId of childIds(graph, id)) {
      visit(childId);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return result;
}

function childIds(graph: TicketGraph, id: string): string[] {
  return [...(graph.childrenByParentId.get(id) ?? [])]
    .map((task) => task.id)
    .sort(compareTaskIds);
}

function compareReadyTickets(
  a: BacklogTaskRecord,
  b: BacklogTaskRecord
): number {
  return (
    priorityRank(a) - priorityRank(b) ||
    ordinal(a) - ordinal(b) ||
    compareTaskIds(a.id, b.id)
  );
}

function priorityRank(task: BacklogTaskRecord): number {
  return PRIORITY_RANK[task.priority ?? "medium"];
}

function ordinal(task: BacklogTaskRecord): number {
  return task.ordinal ?? Number.MAX_SAFE_INTEGER;
}
