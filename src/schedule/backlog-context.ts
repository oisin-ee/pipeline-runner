import { join } from "node:path";

import { Effect, Option } from "effect";
import matter from "gray-matter";

import type { BacklogWorkUnit, SchedulePlanningContext } from "../planning/generate";
import { createDependencyGraph, descendantGraphValues } from "../planning/graph";
import type { DependencyGraph } from "../planning/graph";
import { RepoIoService, runRepoIoSync } from "../runtime/services/repo-io-service";
import { extractTicketIds } from "../task-ref";

const DESCRIPTION_SECTION_RE = /## Description\s+([\s\S]*?)(?=\n## |\s*$)/u;
const ACCEPTANCE_SECTION_RE = /## Acceptance Criteria\s+([\s\S]*?)(?=\n## |\s*$)/u;
const ACCEPTANCE_ITEM_RE = /^\s*-\s*\[[ xX]\]\s*#?([\w.-]+)\s+(.+)$/u;
const LINE_RE = /\r?\n/u;

interface BacklogPlanningAccumulator {
  parentIds: Set<string>;
  parentWorkUnits: BacklogWorkUnit[];
  workUnitIds: Set<string>;
  workUnits: BacklogWorkUnit[];
}

const emptyPlanningContext = (): BacklogPlanningAccumulator => ({
  parentIds: new Set<string>(),
  parentWorkUnits: [],
  workUnitIds: new Set<string>(),
  workUnits: [],
});

const descendantBacklogTasks = (taskId: string, taskGraph: DependencyGraph<BacklogTaskFile>): BacklogTaskFile[] =>
  descendantGraphValues(taskGraph, taskId);

const compareBacklogTaskIds = (a: BacklogTaskFile, b: BacklogTaskFile): number =>
  a.id.localeCompare(b.id, undefined, { numeric: true });

const backlogTaskGraph = (tasks: BacklogTaskFile[]): DependencyGraph<BacklogTaskFile> => {
  const sortedTasks = [...tasks].toSorted(compareBacklogTaskIds);
  return createDependencyGraph(sortedTasks, {
    dependenciesOf: (task) =>
      Option.match(task.parentTaskId, {
        onNone: () => [],
        onSome: (parentTaskId) => [parentTaskId],
      }),
    valueOf: (task) => task,
  });
};

const addUniqueWorkUnit = (workUnit: BacklogWorkUnit, target: BacklogWorkUnit[], seen: Set<string>): void => {
  if (seen.has(workUnit.id)) {
    return;
  }
  seen.add(workUnit.id);
  target.push(workUnit);
};

const addTaskWorkUnits = (
  taskFile: BacklogTaskFile,
  descendants: BacklogTaskFile[],
  context: BacklogPlanningAccumulator,
): void => {
  if (descendants.length === 0) {
    addUniqueWorkUnit(taskFile.workUnit, context.workUnits, context.workUnitIds);
    return;
  }
  addUniqueWorkUnit(taskFile.workUnit, context.parentWorkUnits, context.parentIds);
  for (const descendant of descendants) {
    addUniqueWorkUnit(descendant.workUnit, context.workUnits, context.workUnitIds);
  }
};

const addTicketWorkUnits = (
  ticketId: string,
  tasksById: Map<string, BacklogTaskFile>,
  taskGraph: DependencyGraph<BacklogTaskFile>,
  context: BacklogPlanningAccumulator,
): void => {
  const taskFile = tasksById.get(ticketId);
  if (!taskFile) {
    return;
  }
  const descendants = descendantBacklogTasks(ticketId, taskGraph);
  addTaskWorkUnits(taskFile, descendants, context);
};

interface BacklogTaskFile {
  id: string;
  parentTaskId: Option.Option<string>;
  workUnit: BacklogWorkUnit;
}

const isMarkdownFile = (entry: { isFile(): boolean; name: string }): boolean =>
  entry.isFile() && entry.name.endsWith(".md");

const stringFrontmatter = (value: unknown): Option.Option<string> => {
  if (typeof value !== "string") {
    return Option.none();
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const stringArrayFrontmatter = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const optionalStringField = (key: string, value: Option.Option<string>): Record<string, string> =>
  Option.match(value, {
    onNone: () => ({}),
    onSome: (resolved) => ({ [key]: resolved }),
  });

const optionalStringArrayField = (key: string, value: string[]): Record<string, string[]> =>
  value.length > 0 ? { [key]: value } : {};

const cleanupMarkdownSection = (value: Option.Option<string>): Option.Option<string> =>
  Option.match(value, {
    onNone: () => Option.none(),
    onSome: (source) => {
      const cleaned = source
        .split(LINE_RE)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");
      return cleaned.length > 0 ? Option.some(cleaned) : Option.none();
    },
  });

const betweenMarkers = (content: string, start: string, end: string): Option.Option<string> => {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return Option.none();
  }
  return cleanupMarkdownSection(Option.some(content.slice(startIndex + start.length, endIndex)));
};

const descriptionFromMarkdown = (content: string): Option.Option<string> => {
  const marked = betweenMarkers(content, "<!-- SECTION:DESCRIPTION:BEGIN -->", "<!-- SECTION:DESCRIPTION:END -->");
  if (Option.isSome(marked)) {
    return marked;
  }
  const match = DESCRIPTION_SECTION_RE.exec(content);
  return match === null ? Option.none() : cleanupMarkdownSection(Option.some(match[1]));
};

const acceptanceCriteriaFromMarkdown = (content: string): { id: string; text: string }[] => {
  const markerSection = betweenMarkers(content, "<!-- AC:BEGIN -->", "<!-- AC:END -->");
  const marked = Option.match(markerSection, {
    onNone: () => {
      const match = ACCEPTANCE_SECTION_RE.exec(content);
      return match === null ? "" : match[1];
    },
    onSome: (section) => section,
  });
  return marked
    .split(LINE_RE)
    .map((line) => ACCEPTANCE_ITEM_RE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      id: match[1],
      text: match[2].trim(),
    }))
    .filter((criterion) => criterion.id.length > 0 && criterion.text.length > 0);
};

const parseBacklogTaskFile = (source: string): BacklogTaskFile[] => {
  const parsed = matter(source);
  const id = stringFrontmatter(parsed.data.id);
  return Option.match(id, {
    onNone: () => [],
    onSome: (taskId) => [
      {
        id: taskId,
        parentTaskId: stringFrontmatter(parsed.data.parent_task_id),
        workUnit: {
          acceptance_criteria: acceptanceCriteriaFromMarkdown(parsed.content),
          ...optionalStringArrayField("dependencies", stringArrayFrontmatter(parsed.data.dependencies)),
          ...optionalStringField("description", descriptionFromMarkdown(parsed.content)),
          id: taskId,
          ...optionalStringField("title", stringFrontmatter(parsed.data.title)),
        },
      },
    ],
  });
};

const readBacklogTaskFileEffect = (path: string): Effect.Effect<BacklogTaskFile[], unknown, RepoIoService> =>
  Effect.gen(function* effectBody() {
    const service = yield* RepoIoService;
    return parseBacklogTaskFile(yield* service.readText(path));
  });

const readBacklogTasksEffect = (worktreePath: string): Effect.Effect<BacklogTaskFile[], unknown, RepoIoService> => {
  const tasksDir = join(worktreePath, "backlog", "tasks");
  return Effect.gen(function* effectBody() {
    const service = yield* RepoIoService;
    if (!(yield* service.exists(tasksDir))) {
      return [];
    }
    const entries = yield* service.readDir(tasksDir);
    return yield* Effect.all(
      entries.filter(isMarkdownFile).map((entry) => readBacklogTaskFileEffect(join(tasksDir, entry.name))),
    ).pipe(Effect.map((tasks) => tasks.flat()));
  });
};

const loadBacklogPlanningContextEffect = (
  task: string,
  worktreePath: string,
): Effect.Effect<SchedulePlanningContext, unknown, RepoIoService> =>
  Effect.gen(function* effectBody() {
    const ticketIds = extractTicketIds(task);
    if (ticketIds.length === 0) {
      return { parentWorkUnits: [], workUnits: [] };
    }
    const tasks = yield* readBacklogTasksEffect(worktreePath);
    const tasksById = new Map(tasks.map((taskFile) => [taskFile.id, taskFile]));
    const taskGraph = backlogTaskGraph(tasks);
    const context = emptyPlanningContext();

    for (const ticketId of ticketIds) {
      addTicketWorkUnits(ticketId, tasksById, taskGraph, context);
    }

    return {
      parentWorkUnits: context.parentWorkUnits,
      workUnits: context.workUnits,
    };
  });

export const loadBacklogPlanningContext = (task: string, worktreePath: string): SchedulePlanningContext =>
  runRepoIoSync(loadBacklogPlanningContextEffect(task, worktreePath));
