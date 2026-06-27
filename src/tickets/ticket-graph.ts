import { Data, Effect } from "effect";
import {
  createDependencyGraph,
  type DependencyGraph,
  dependencyBatches,
  dependencyCycleIds,
  dependencyGraphHasNode,
  dependencyGraphNodeIds,
  dependencyPredecessorIds,
} from "../planning/graph";
import type { BacklogTaskRecord } from "./backlog-task-store";
import {
  compareBacklogTasks,
  compareTicketIds,
  indexChildrenByParentId,
} from "./ticket-task-index";

export interface TicketGraph {
  readonly childrenByParentId: ReadonlyMap<
    string,
    readonly BacklogTaskRecord[]
  >;
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

export function buildTicketGraphEffect(
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<TicketGraph, TicketGraphError> {
  return Effect.gen(function* () {
    const graph = buildUncheckedTicketGraph(tasks);

    const cycles = dependencyCycleIds(graph.dependencyGraph);
    if (cycles.length > 0) {
      return yield* Effect.fail(
        new TicketGraphError({
          message: `Backlog dependency graph contains cycle: ${cycles
            .map((cycle) => cycle.sort(compareTaskIds).join(" -> "))
            .join("; ")}`,
        })
      );
    }

    return graph;
  });
}

export function sequenceTicketBatchesEffect(
  graph: TicketGraph,
  ticketIds: readonly string[] = dependencyGraphNodeIds(graph.dependencyGraph)
): Effect.Effect<string[][], TicketGraphError> {
  return Effect.gen(function* () {
    const batches = sequenceUncheckedTicketBatches(graph, ticketIds);
    if (batches.length === 0 && ticketIds.length > 0) {
      return yield* Effect.fail(
        new TicketGraphError({
          message: `Backlog dependency graph cannot be sequenced: ${[
            ...ticketIds,
          ]
            .sort(compareTaskIds)
            .join(", ")}`,
        })
      );
    }
    return batches;
  });
}

export function scopedTicketIds(graph: TicketGraph, rootId?: string): string[] {
  if (!rootId) {
    return dependencyGraphNodeIds(graph.dependencyGraph).sort(compareTaskIds);
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
  return [...ids].sort(compareTaskIds);
}

export function predecessorIds(graph: TicketGraph, id: string): string[] {
  return dependencyPredecessorIds(graph.dependencyGraph, id).sort(
    compareTaskIds
  );
}

export function compareTaskIds(a: string, b: string): number {
  return compareTicketIds(a, b);
}

function buildUncheckedTicketGraph(
  tasks: readonly BacklogTaskRecord[]
): TicketGraph {
  const sortedTasks = [...tasks].sort(compareTasks);
  const tasksById = indexTasksById(sortedTasks);
  const dependencyGraph = buildDependencyGraph(sortedTasks);
  const childrenByParentId = indexChildrenByParentId(sortedTasks);
  const danglingDependencies = missingDependencyMessages(
    sortedTasks,
    tasksById
  );

  return {
    childrenByParentId,
    danglingDependencies,
    dependencyGraph,
    tasksById,
  };
}

function indexTasksById(
  tasks: readonly BacklogTaskRecord[]
): ReadonlyMap<string, BacklogTaskRecord> {
  const tasksById = new Map<string, BacklogTaskRecord>();
  for (const task of tasks) {
    tasksById.set(task.id, task);
  }
  return tasksById;
}

function buildDependencyGraph(
  tasks: readonly BacklogTaskRecord[]
): DependencyGraph<BacklogTaskRecord> {
  return createDependencyGraph(tasks, {
    dependenciesOf: (task) => task.dependencies,
    valueOf: (task) => task,
  });
}

function missingDependencyMessages(
  tasks: readonly BacklogTaskRecord[],
  tasksById: ReadonlyMap<string, BacklogTaskRecord>
): string[] {
  const messages: string[] = [];
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!tasksById.has(dependency)) {
        messages.push(`${task.id} depends on missing ${dependency}`);
      }
    }
  }
  return messages;
}

function sequenceUncheckedTicketBatches(
  graph: TicketGraph,
  ticketIds: readonly string[]
): string[][] {
  return dependencyBatches(graph.dependencyGraph, ticketIds, compareTaskIds);
}

function compareTasks(a: BacklogTaskRecord, b: BacklogTaskRecord): number {
  return compareBacklogTasks(a, b);
}
