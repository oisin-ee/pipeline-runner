import type { BacklogTaskRecord } from "./backlog-task-store";

export function compareTicketIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function compareBacklogTasks(
  a: BacklogTaskRecord,
  b: BacklogTaskRecord
): number {
  return compareTicketIds(a.id, b.id);
}

export function indexChildrenByParentId(
  tasks: readonly BacklogTaskRecord[]
): ReadonlyMap<string, BacklogTaskRecord[]> {
  const childrenByParentId = new Map<string, BacklogTaskRecord[]>();
  for (const task of tasks) {
    addTaskToParentIndex(childrenByParentId, task);
  }
  sortParentIndex(childrenByParentId);
  return childrenByParentId;
}

function addTaskToParentIndex(
  childrenByParentId: Map<string, BacklogTaskRecord[]>,
  task: BacklogTaskRecord
): void {
  if (!task.parentTaskId) {
    return;
  }
  const siblings = childrenByParentId.get(task.parentTaskId) ?? [];
  siblings.push(task);
  childrenByParentId.set(task.parentTaskId, siblings);
}

function sortParentIndex(
  childrenByParentId: ReadonlyMap<string, BacklogTaskRecord[]>
): void {
  for (const siblings of childrenByParentId.values()) {
    siblings.sort(compareBacklogTasks);
  }
}
