import type { BacklogTaskRecord } from "./backlog-task-store";

export const compareTicketIds = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

export const compareBacklogTasks = (a: BacklogTaskRecord, b: BacklogTaskRecord): number => compareTicketIds(a.id, b.id);

const addTaskToParentIndex = (childrenByParentId: Map<string, BacklogTaskRecord[]>, task: BacklogTaskRecord): void => {
  if (task.parentTaskId === undefined || task.parentTaskId.length === 0) {
    return;
  }
  const siblings = childrenByParentId.get(task.parentTaskId) ?? [];
  siblings.push(task);
  childrenByParentId.set(task.parentTaskId, siblings);
};

const sortParentIndex = (childrenByParentId: ReadonlyMap<string, BacklogTaskRecord[]>): void => {
  for (const siblings of childrenByParentId.values()) {
    siblings.sort(compareBacklogTasks);
  }
};

export const indexChildrenByParentId = (
  tasks: readonly BacklogTaskRecord[],
): ReadonlyMap<string, BacklogTaskRecord[]> => {
  const childrenByParentId = new Map<string, BacklogTaskRecord[]>();
  for (const task of tasks) {
    addTaskToParentIndex(childrenByParentId, task);
  }
  sortParentIndex(childrenByParentId);
  return childrenByParentId;
};
