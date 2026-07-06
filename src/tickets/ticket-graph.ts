import { Data, Effect } from "effect";

import {
  createDependencyGraph,
  dependencyBatches,
  dependencyCycleIds,
  dependencyGraphHasNode,
  dependencyGraphNodeIds,
  dependencyPredecessorIds,
} from "../planning/graph";
import type { DependencyGraph } from "../planning/graph";
import type { BacklogTaskRecord } from "./backlog-task-store";
import { compareBacklogTasks, compareTicketIds, indexChildrenByParentId } from "./ticket-task-index";

export interface TicketGraph {
  readonly childrenByParentId: ReadonlyMap<string, readonly BacklogTaskRecord[]>;
  /**
   * Human-readable descriptions of dependencies that reference tasks absent
   * from this backlog (archived, completed-and-pruned, or cross-tree). These
   * edges are intentionally dropped from {@link dependencyGraph} and treated as
   * non-blocking by selection, but are surfaced so integrity issues stay
   * visible without aborting ticket selection on real-world backlogs.
   */
  readonly danglingDependencies: readonly string[];
  readonly dependencyGraph: DependencyGraph<BacklogTaskRecord>;
  readonly tasksById: ReadonlyMap<string, BacklogTaskRecord>;
}

export class TicketGraphError extends Data.TaggedError("TicketGraphError")<{
  readonly message: string;
}> {}

export const compareTaskIds = (a: string, b: string): number => compareTicketIds(a, b);

export const scopedTicketIds = (graph: TicketGraph, rootId?: string): string[] => {
  if (rootId === undefined || rootId.length === 0) {
    return dependencyGraphNodeIds(graph.dependencyGraph).toSorted(compareTaskIds);
  }
  if (!dependencyGraphHasNode(graph.dependencyGraph, rootId)) {
    return [];
  }
  const ids = new Set<string>([rootId]);
  const visit = (id: string): void => {
    for (const child of graph.childrenByParentId.get(id) ?? []) {
      ids.add(child.id);
      visit(child.id);
    }
  };
  visit(rootId);
  return [...ids].toSorted(compareTaskIds);
};

export const predecessorIds = (graph: TicketGraph, id: string): string[] =>
  dependencyPredecessorIds(graph.dependencyGraph, id).toSorted(compareTaskIds);

const indexTasksById = (tasks: readonly BacklogTaskRecord[]): ReadonlyMap<string, BacklogTaskRecord> => {
  const tasksById = new Map<string, BacklogTaskRecord>();
  for (const task of tasks) {
    tasksById.set(task.id, task);
  }
  return tasksById;
};

const buildDependencyGraph = (tasks: readonly BacklogTaskRecord[]): DependencyGraph<BacklogTaskRecord> =>
  createDependencyGraph(tasks, {
    dependenciesOf: (task) => task.dependencies,
    valueOf: (task) => task,
  });

const missingDependencyMessages = (
  tasks: readonly BacklogTaskRecord[],
  tasksById: ReadonlyMap<string, BacklogTaskRecord>,
): string[] => {
  const messages: string[] = [];
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!tasksById.has(dependency)) {
        messages.push(`${task.id} depends on missing ${dependency}`);
      }
    }
  }
  return messages;
};

const sequenceUncheckedTicketBatches = (graph: TicketGraph, ticketIds: readonly string[]): string[][] =>
  dependencyBatches(graph.dependencyGraph, ticketIds, compareTaskIds);

export const sequenceTicketBatchesEffect = (
  graph: TicketGraph,
  ticketIds: readonly string[] = dependencyGraphNodeIds(graph.dependencyGraph),
): Effect.Effect<string[][], TicketGraphError> =>
  Effect.gen(function* effectBody() {
    const batches = sequenceUncheckedTicketBatches(graph, ticketIds);
    if (batches.length === 0 && ticketIds.length > 0) {
      return yield* Effect.fail(
        new TicketGraphError({
          message: `Backlog dependency graph cannot be sequenced: ${[...ticketIds]
            .toSorted(compareTaskIds)
            .join(", ")}`,
        }),
      );
    }
    return batches;
  });

const compareTasks = (a: BacklogTaskRecord, b: BacklogTaskRecord): number => compareBacklogTasks(a, b);

const buildUncheckedTicketGraph = (tasks: readonly BacklogTaskRecord[]): TicketGraph => {
  const sortedTasks = [...tasks].toSorted(compareTasks);
  const tasksById = indexTasksById(sortedTasks);
  const dependencyGraph = buildDependencyGraph(sortedTasks);
  const childrenByParentId = indexChildrenByParentId(sortedTasks);
  const danglingDependencies = missingDependencyMessages(sortedTasks, tasksById);

  return {
    childrenByParentId,
    danglingDependencies,
    dependencyGraph,
    tasksById,
  };
};

export const buildTicketGraphEffect = (
  tasks: readonly BacklogTaskRecord[],
): Effect.Effect<TicketGraph, TicketGraphError> =>
  Effect.gen(function* effectBody() {
    const graph = buildUncheckedTicketGraph(tasks);

    const cycles = dependencyCycleIds(graph.dependencyGraph);
    if (cycles.length > 0) {
      return yield* Effect.fail(
        new TicketGraphError({
          message: `Backlog dependency graph contains cycle: ${cycles
            .map((cycle) => cycle.toSorted(compareTaskIds).join(" -> "))
            .join("; ")}`,
        }),
      );
    }

    return graph;
  });
