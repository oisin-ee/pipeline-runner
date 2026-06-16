import { join } from "node:path";
import { alg, Graph } from "@dagrejs/graphlib";
import { Effect } from "effect";
import matter from "gray-matter";
import type {
  BacklogWorkUnit,
  SchedulePlanningContext,
} from "../planning/generate";
import {
  RepoIoService,
  runRepoIoSync,
} from "../runtime/services/repo-io-service";
import { extractTicketIds } from "../task-ref";

const DESCRIPTION_SECTION_RE = /## Description\s+([\s\S]*?)(?=\n## |\s*$)/;
const ACCEPTANCE_SECTION_RE =
  /## Acceptance Criteria\s+([\s\S]*?)(?=\n## |\s*$)/;
const ACCEPTANCE_ITEM_RE = /^\s*-\s*\[[ xX]\]\s*#?([\w.-]+)\s+(.+)$/;
const LINE_RE = /\r?\n/;

export function loadBacklogPlanningContext(
  task: string,
  worktreePath: string
): SchedulePlanningContext {
  return runRepoIoSync(loadBacklogPlanningContextEffect(task, worktreePath));
}

function loadBacklogPlanningContextEffect(
  task: string,
  worktreePath: string
): Effect.Effect<SchedulePlanningContext, unknown, RepoIoService> {
  return Effect.gen(function* () {
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
}

interface BacklogPlanningAccumulator {
  parentIds: Set<string>;
  parentWorkUnits: BacklogWorkUnit[];
  workUnitIds: Set<string>;
  workUnits: BacklogWorkUnit[];
}

function emptyPlanningContext(): BacklogPlanningAccumulator {
  return {
    parentIds: new Set<string>(),
    parentWorkUnits: [],
    workUnitIds: new Set<string>(),
    workUnits: [],
  };
}

function addTicketWorkUnits(
  ticketId: string,
  tasksById: Map<string, BacklogTaskFile>,
  taskGraph: Graph<undefined, BacklogTaskFile>,
  context: BacklogPlanningAccumulator
): void {
  const taskFile = tasksById.get(ticketId);
  if (!taskFile) {
    return;
  }
  const descendants = descendantBacklogTasks(ticketId, taskGraph);
  addTaskWorkUnits(taskFile, descendants, context);
}

function addTaskWorkUnits(
  taskFile: BacklogTaskFile,
  descendants: BacklogTaskFile[],
  context: BacklogPlanningAccumulator
): void {
  if (descendants.length === 0) {
    addUniqueWorkUnit(
      taskFile.workUnit,
      context.workUnits,
      context.workUnitIds
    );
    return;
  }
  addUniqueWorkUnit(
    taskFile.workUnit,
    context.parentWorkUnits,
    context.parentIds
  );
  for (const descendant of descendants) {
    addUniqueWorkUnit(
      descendant.workUnit,
      context.workUnits,
      context.workUnitIds
    );
  }
}

function backlogTaskGraph(
  tasks: BacklogTaskFile[]
): Graph<undefined, BacklogTaskFile> {
  const graph = new Graph<undefined, BacklogTaskFile>();
  const sortedTasks = [...tasks].sort(compareBacklogTaskIds);
  for (const task of sortedTasks) {
    graph.setNode(task.id, task);
  }
  for (const task of sortedTasks) {
    if (task.parentTaskId && graph.hasNode(task.parentTaskId)) {
      graph.setEdge(task.parentTaskId, task.id);
    }
  }
  return graph;
}

function descendantBacklogTasks(
  taskId: string,
  taskGraph: Graph<undefined, BacklogTaskFile>
): BacklogTaskFile[] {
  if (!taskGraph.hasNode(taskId)) {
    return [];
  }
  return alg
    .preorder(taskGraph, taskId)
    .slice(1)
    .map((id) => taskGraph.node(id))
    .filter((task): task is BacklogTaskFile => Boolean(task));
}

function compareBacklogTaskIds(a: BacklogTaskFile, b: BacklogTaskFile): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function addUniqueWorkUnit(
  workUnit: BacklogWorkUnit,
  target: BacklogWorkUnit[],
  seen: Set<string>
): void {
  if (seen.has(workUnit.id)) {
    return;
  }
  seen.add(workUnit.id);
  target.push(workUnit);
}

interface BacklogTaskFile {
  id: string;
  parentTaskId?: string;
  workUnit: BacklogWorkUnit;
}

function readBacklogTasksEffect(
  worktreePath: string
): Effect.Effect<BacklogTaskFile[], unknown, RepoIoService> {
  const tasksDir = join(worktreePath, "backlog", "tasks");
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    if (!(yield* service.exists(tasksDir))) {
      return [];
    }
    const entries = yield* service.readDir(tasksDir);
    return yield* Effect.all(
      entries
        .filter(isMarkdownFile)
        .map((entry) => readBacklogTaskFileEffect(join(tasksDir, entry.name)))
    ).pipe(Effect.map((tasks) => tasks.flat()));
  });
}

function isMarkdownFile(entry: { isFile(): boolean; name: string }): boolean {
  return entry.isFile() && entry.name.endsWith(".md");
}

function readBacklogTaskFileEffect(
  path: string
): Effect.Effect<BacklogTaskFile[], unknown, RepoIoService> {
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    return parseBacklogTaskFile(yield* service.readText(path));
  });
}

function parseBacklogTaskFile(source: string): BacklogTaskFile[] {
  const parsed = matter(source);
  const id = stringFrontmatter(parsed.data.id);
  if (!id) {
    return [];
  }
  return [
    {
      id,
      parentTaskId: stringFrontmatter(parsed.data.parent_task_id),
      workUnit: {
        acceptance_criteria: acceptanceCriteriaFromMarkdown(parsed.content),
        ...optionalStringArrayField(
          "dependencies",
          stringArrayFrontmatter(parsed.data.dependencies)
        ),
        ...optionalStringField(
          "description",
          descriptionFromMarkdown(parsed.content)
        ),
        id,
        ...optionalStringField("title", stringFrontmatter(parsed.data.title)),
      },
    },
  ];
}

function stringFrontmatter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayFrontmatter(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalStringField<TKey extends string>(
  key: TKey,
  value: string | undefined
): Record<TKey, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<TKey, string>) : {};
}

function optionalStringArrayField<TKey extends string>(
  key: TKey,
  value: string[]
): Record<TKey, string[]> | Record<string, never> {
  return value.length > 0 ? ({ [key]: value } as Record<TKey, string[]>) : {};
}

function descriptionFromMarkdown(content: string): string | undefined {
  const marked = betweenMarkers(
    content,
    "<!-- SECTION:DESCRIPTION:BEGIN -->",
    "<!-- SECTION:DESCRIPTION:END -->"
  );
  if (marked) {
    return marked;
  }
  const match = content.match(DESCRIPTION_SECTION_RE);
  return cleanupMarkdownSection(match?.[1]);
}

function acceptanceCriteriaFromMarkdown(
  content: string
): Array<{ id: string; text: string }> {
  const marked =
    betweenMarkers(content, "<!-- AC:BEGIN -->", "<!-- AC:END -->") ??
    content.match(ACCEPTANCE_SECTION_RE)?.[1] ??
    "";
  return marked
    .split(LINE_RE)
    .map((line) => line.match(ACCEPTANCE_ITEM_RE))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      id: match[1] ?? "",
      text: (match[2] ?? "").trim(),
    }))
    .filter((criterion) => criterion.id && criterion.text);
}

function betweenMarkers(
  content: string,
  start: string,
  end: string
): string | undefined {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return;
  }
  return cleanupMarkdownSection(
    content.slice(startIndex + start.length, endIndex)
  );
}

function cleanupMarkdownSection(value: string | undefined): string | undefined {
  const cleaned = value
    ?.split(LINE_RE)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return cleaned || undefined;
}
