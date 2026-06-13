import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alg, Graph } from "@dagrejs/graphlib";
import matter from "gray-matter";
import type {
  BacklogWorkUnit,
  SchedulePlanningContext,
} from "../planning/generate";
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
  const ticketIds = extractTicketIds(task);
  if (ticketIds.length === 0) {
    return { parentWorkUnits: [], workUnits: [] };
  }
  const tasks = readBacklogTasks(worktreePath);
  const tasksById = new Map(tasks.map((taskFile) => [taskFile.id, taskFile]));
  const taskGraph = backlogTaskGraph(tasks);
  const parentWorkUnits: BacklogWorkUnit[] = [];
  const workUnits: BacklogWorkUnit[] = [];
  const parentIds = new Set<string>();
  const workUnitIds = new Set<string>();

  for (const ticketId of ticketIds) {
    const taskFile = tasksById.get(ticketId);
    if (!taskFile) {
      continue;
    }
    const descendants = descendantBacklogTasks(ticketId, taskGraph);
    if (descendants.length === 0) {
      addUniqueWorkUnit(taskFile.workUnit, workUnits, workUnitIds);
      continue;
    }
    addUniqueWorkUnit(taskFile.workUnit, parentWorkUnits, parentIds);
    for (const descendant of descendants) {
      addUniqueWorkUnit(descendant.workUnit, workUnits, workUnitIds);
    }
  }

  return {
    parentWorkUnits,
    workUnits,
  };
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

function readBacklogTasks(worktreePath: string): BacklogTaskFile[] {
  const tasksDir = join(worktreePath, "backlog", "tasks");
  if (!existsSync(tasksDir)) {
    return [];
  }
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .flatMap((entry) => readBacklogTaskFile(join(tasksDir, entry.name)));
}

function readBacklogTaskFile(path: string): BacklogTaskFile[] {
  const parsed = matter(readFileSync(path, "utf8"));
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
