import { alg, Graph } from "@dagrejs/graphlib";
import { Data, Effect } from "effect";
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
  readonly dependencyGraph: Graph<undefined, BacklogTaskRecord>;
  readonly tasksById: ReadonlyMap<string, BacklogTaskRecord>;
}

class TicketGraphError extends Data.TaggedError("TicketGraphError")<{
  readonly message: string;
}> {}

export function buildTicketGraphEffect(
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<TicketGraph, TicketGraphError> {
  return Effect.gen(function* () {
    const graph = buildUncheckedTicketGraph(tasks);

    const cycles = alg.findCycles(graph.dependencyGraph);
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
  ticketIds: readonly string[] = graph.dependencyGraph.nodes()
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
    return graph.dependencyGraph.nodes().sort(compareTaskIds);
  }
  if (!graph.tasksById.has(rootId)) {
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
  return [...(graph.dependencyGraph.predecessors(id) ?? [])].sort(
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
  const dependencyGraph = buildDependencyGraph(sortedTasks, tasksById);
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
  tasks: readonly BacklogTaskRecord[],
  tasksById: ReadonlyMap<string, BacklogTaskRecord>
): Graph<undefined, BacklogTaskRecord> {
  const dependencyGraph = new Graph<undefined, BacklogTaskRecord>({
    directed: true,
  });
  addDependencyNodes(dependencyGraph, tasks);
  addDependencyEdges(dependencyGraph, tasks, tasksById);
  return dependencyGraph;
}

function addDependencyNodes(
  dependencyGraph: Graph<undefined, BacklogTaskRecord>,
  tasks: readonly BacklogTaskRecord[]
): void {
  for (const task of tasks) {
    dependencyGraph.setNode(task.id, task);
  }
}

function addDependencyEdges(
  dependencyGraph: Graph<undefined, BacklogTaskRecord>,
  tasks: readonly BacklogTaskRecord[],
  tasksById: ReadonlyMap<string, BacklogTaskRecord>
): void {
  for (const task of tasks) {
    addTaskDependencyEdges(dependencyGraph, task, tasksById);
  }
}

function addTaskDependencyEdges(
  dependencyGraph: Graph<undefined, BacklogTaskRecord>,
  task: BacklogTaskRecord,
  tasksById: ReadonlyMap<string, BacklogTaskRecord>
): void {
  for (const dependency of task.dependencies) {
    if (tasksById.has(dependency)) {
      dependencyGraph.setEdge(dependency, task.id);
    }
  }
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
  const remaining = new Set(ticketIds);
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        predecessorIds(graph, id).every(
          (dependency) => !remaining.has(dependency)
        )
      )
      .sort(compareTaskIds);
    if (ready.length === 0) {
      return [];
    }
    batches.push(ready);
    for (const id of ready) {
      remaining.delete(id);
    }
  }
  return batches;
}

function compareTasks(a: BacklogTaskRecord, b: BacklogTaskRecord): number {
  return compareBacklogTasks(a, b);
}
