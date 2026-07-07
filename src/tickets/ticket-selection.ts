import { Option } from "effect";

import type { BacklogTaskRecord } from "./backlog-task-store";
import {
  compareTaskIds,
  predecessorIds,
  scopedTicketIds,
} from "./ticket-graph";
import type { TicketGraph } from "./ticket-graph";

const PRIORITY_RANK = {
  high: 0,
  low: 2,
  medium: 1,
} as const;

export type TicketSelectionStrategy = "bfs" | "dfs" | "priority";

export interface TicketSelectionOptions {
  readonly includeParents?: boolean;
  readonly rootId?: string;
  readonly strategy?: TicketSelectionStrategy;
}

const hasIncompleteChildren = (graph: TicketGraph, taskId: string): boolean =>
  (graph.childrenByParentId.get(taskId) ?? []).some(
    (child) => child.status !== "Done"
  );

const isReadyTicket = (
  graph: TicketGraph,
  task: BacklogTaskRecord,
  options: TicketSelectionOptions
): boolean =>
  task.status === "To Do" &&
  (options.includeParents === true || !hasIncompleteChildren(graph, task.id)) &&
  predecessorIds(graph, task.id).every(
    (dependencyId) => graph.tasksById.get(dependencyId)?.status === "Done"
  );

const rootIds = (graph: TicketGraph): string[] =>
  scopedTicketIds(graph)
    .filter((id) => graph.tasksById.get(id)?.parentTaskId === undefined)
    .toSorted(compareTaskIds);

const childIds = (graph: TicketGraph, id: string): string[] =>
  [...(graph.childrenByParentId.get(id) ?? [])]
    .map((task) => task.id)
    .toSorted(compareTaskIds);

const bfsIds = (graph: TicketGraph, roots: readonly string[]): string[] => {
  const result: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) {
      continue;
    }
    result.push(id);
    queue.push(...childIds(graph, id));
  }
  return result;
};

const dfsIds = (graph: TicketGraph, roots: readonly string[]): string[] => {
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
};

const traversalIds = (
  graph: TicketGraph,
  rootId: Option.Option<string>,
  strategy: Option.Option<TicketSelectionStrategy>
): string[] => {
  const roots = Option.isSome(rootId) ? [rootId.value] : rootIds(graph);
  return Option.isSome(strategy) && strategy.value === "dfs"
    ? dfsIds(graph, roots)
    : bfsIds(graph, roots);
};

const priorityRank = (task: BacklogTaskRecord): number =>
  PRIORITY_RANK[task.priority ?? "medium"];

const ordinal = (task: BacklogTaskRecord): number =>
  task.ordinal ?? Number.MAX_SAFE_INTEGER;

const compareReadyTickets = (
  a: BacklogTaskRecord,
  b: BacklogTaskRecord
): number =>
  priorityRank(a) - priorityRank(b) ||
  ordinal(a) - ordinal(b) ||
  compareTaskIds(a.id, b.id);

const orderByTraversal = (
  graph: TicketGraph,
  ready: readonly BacklogTaskRecord[],
  options: TicketSelectionOptions
): BacklogTaskRecord[] => {
  const remaining = new Map(ready.map((task) => [task.id, task]));
  const ordered: BacklogTaskRecord[] = [];
  for (const id of traversalIds(
    graph,
    Option.fromUndefinedOr(options.rootId),
    Option.fromUndefinedOr(options.strategy)
  )) {
    const task = remaining.get(id);
    if (task !== undefined) {
      ordered.push(task);
      remaining.delete(id);
    }
  }
  return [...ordered, ...[...remaining.values()].toSorted(compareReadyTickets)];
};

export const selectReadyTickets = (
  graph: TicketGraph,
  options: TicketSelectionOptions = {}
): BacklogTaskRecord[] => {
  const ready = scopedTicketIds(graph, options.rootId)
    .map((id) => graph.tasksById.get(id))
    .filter((task): task is BacklogTaskRecord => task !== undefined)
    .filter((task) => isReadyTicket(graph, task, options));

  if (options.strategy === "bfs" || options.strategy === "dfs") {
    return orderByTraversal(graph, ready, options);
  }
  return ready.toSorted(compareReadyTickets);
};

export const selectNextTicket = (
  graph: TicketGraph,
  options: TicketSelectionOptions = {}
): Option.Option<BacklogTaskRecord> =>
  Option.fromUndefinedOr(selectReadyTickets(graph, options)[0]);
