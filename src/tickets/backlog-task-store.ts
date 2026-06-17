import { join } from "node:path";
import { Data, Effect } from "effect";
import matter from "gray-matter";
import { z } from "zod";
import { RepoIoService } from "../runtime/services/repo-io-service";
import { indexChildrenByParentId } from "./ticket-task-index";
import { errorMessage, formatZodIssues } from "./validation-error-format";

const LINE_RE = /\r?\n/;
const ACCEPTANCE_ITEM_RE = /^\s*-\s*\[[ xX]\]\s*(?:#?[\w.-]+\s+)?(.+)$/;
const DESCRIPTION_MARKERS = {
  end: "<!-- SECTION:DESCRIPTION:END -->",
  start: "<!-- SECTION:DESCRIPTION:BEGIN -->",
} as const;
const ACCEPTANCE_MARKERS = {
  end: "<!-- AC:END -->",
  start: "<!-- AC:BEGIN -->",
} as const;

const nonEmptyStringSchema = z.string().trim().min(1);

const taskFrontmatterSchema = z
  .object({
    dependencies: z.array(nonEmptyStringSchema).default([]),
    id: nonEmptyStringSchema,
    modified_files: z.array(nonEmptyStringSchema).default([]),
    ordinal: z.number().finite().optional(),
    parent_task_id: nonEmptyStringSchema.optional(),
    priority: z.enum(["high", "medium", "low"]).optional(),
    references: z.array(nonEmptyStringSchema).default([]),
    status: z.enum(["To Do", "In Progress", "Done"]),
    title: nonEmptyStringSchema,
  })
  .passthrough();

type TaskFrontmatter = z.infer<typeof taskFrontmatterSchema>;

export type BacklogTaskPriority = NonNullable<TaskFrontmatter["priority"]>;
export type BacklogTaskStatus = TaskFrontmatter["status"];

export interface BacklogTaskRecord {
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly description?: string;
  readonly filePath: string;
  readonly id: string;
  readonly modifiedFiles: readonly string[];
  readonly ordinal?: number;
  readonly parentTaskId?: string;
  readonly priority?: BacklogTaskPriority;
  readonly references: readonly string[];
  readonly status: BacklogTaskStatus;
  readonly title: string;
}

export interface BacklogTaskStore {
  readonly childrenByParentId: ReadonlyMap<
    string,
    readonly BacklogTaskRecord[]
  >;
  readonly tasks: readonly BacklogTaskRecord[];
  readonly tasksById: ReadonlyMap<string, BacklogTaskRecord>;
}

class BacklogTaskStoreError extends Data.TaggedError("BacklogTaskStoreError")<{
  readonly message: string;
  readonly path?: string;
}> {}

export function loadBacklogTaskStoreEffect(
  worktreePath: string
): Effect.Effect<BacklogTaskStore, BacklogTaskStoreError, RepoIoService> {
  return Effect.gen(function* () {
    const tasks = yield* readBacklogTasksEffect(worktreePath);
    return yield* buildBacklogTaskStoreEffect(tasks);
  });
}

function parseBacklogTaskMarkdownEffect(
  source: string,
  filePath: string
): Effect.Effect<BacklogTaskRecord, BacklogTaskStoreError> {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      catch: (error) =>
        storeError(
          filePath,
          `Could not parse Backlog task frontmatter: ${errorMessage(error)}`
        ),
      try: () => matter(source),
    });
    const frontmatter = yield* decodeFrontmatterEffect(parsed.data, filePath);
    return taskRecordFromDocument(frontmatter, parsed.content, filePath);
  });
}

function readBacklogTasksEffect(
  worktreePath: string
): Effect.Effect<BacklogTaskRecord[], BacklogTaskStoreError, RepoIoService> {
  const tasksDir = join(worktreePath, "backlog", "tasks");
  return Effect.gen(function* () {
    const repoIo = yield* RepoIoService;
    const exists = yield* repoIo
      .exists(tasksDir)
      .pipe(Effect.mapError((error) => ioStoreError(tasksDir, error)));
    if (!exists) {
      return [];
    }
    const entries = yield* repoIo
      .readDir(tasksDir)
      .pipe(Effect.mapError((error) => ioStoreError(tasksDir, error)));
    return yield* Effect.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => {
          const filePath = join(tasksDir, entry.name);
          return repoIo.readText(filePath).pipe(
            Effect.mapError((error) => ioStoreError(filePath, error)),
            Effect.flatMap((source) =>
              parseBacklogTaskMarkdownEffect(source, filePath)
            )
          );
        })
    );
  });
}

function decodeFrontmatterEffect(
  frontmatter: unknown,
  filePath: string
): Effect.Effect<TaskFrontmatter, BacklogTaskStoreError> {
  const decoded = taskFrontmatterSchema.safeParse(frontmatter);
  if (decoded.success) {
    return Effect.succeed(decoded.data);
  }
  return Effect.fail(
    storeError(
      filePath,
      `Invalid Backlog task frontmatter in ${filePath}: ${formatZodIssues(
        decoded.error.issues
      )}`
    )
  );
}

function buildBacklogTaskStoreEffect(
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<BacklogTaskStore, BacklogTaskStoreError> {
  return Effect.gen(function* () {
    const tasksById = yield* indexTasksByIdEffect(tasks);
    const childrenByParentId = indexChildrenByParentId(tasks);
    return { childrenByParentId, tasks, tasksById };
  });
}

function indexTasksByIdEffect(
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<
  ReadonlyMap<string, BacklogTaskRecord>,
  BacklogTaskStoreError
> {
  const tasksById = new Map<string, BacklogTaskRecord>();
  for (const task of tasks) {
    const existing = tasksById.get(task.id);
    if (existing) {
      return Effect.fail(
        storeError(
          task.filePath,
          `Duplicate Backlog task id ${task.id}: ${existing.filePath} and ${task.filePath}`
        )
      );
    }
    tasksById.set(task.id, task);
  }
  return Effect.succeed(tasksById);
}

function taskRecordFromDocument(
  frontmatter: TaskFrontmatter,
  content: string,
  filePath: string
): BacklogTaskRecord {
  return {
    acceptanceCriteria: extractAcceptanceCriteria(content),
    dependencies: frontmatter.dependencies,
    description: extractDescription(content),
    filePath,
    id: frontmatter.id,
    modifiedFiles: frontmatter.modified_files,
    ordinal: frontmatter.ordinal,
    parentTaskId: frontmatter.parent_task_id,
    priority: frontmatter.priority,
    references: frontmatter.references,
    status: frontmatter.status,
    title: frontmatter.title,
  };
}

function extractDescription(content: string): string | undefined {
  return extractMarkedBlock(content, DESCRIPTION_MARKERS);
}

function extractAcceptanceCriteria(content: string): string[] {
  return extractMarkedBlock(content, ACCEPTANCE_MARKERS)
    .split(LINE_RE)
    .map((line) => ACCEPTANCE_ITEM_RE.exec(line)?.[1]?.trim())
    .filter((criterion): criterion is string => Boolean(criterion));
}

function extractMarkedBlock(
  content: string,
  markers: { readonly end: string; readonly start: string }
): string {
  const start = content.indexOf(markers.start);
  if (start < 0) {
    return "";
  }
  const bodyStart = start + markers.start.length;
  const end = content.indexOf(markers.end, bodyStart);
  if (end < 0) {
    return "";
  }
  return content.slice(bodyStart, end).trim();
}

function ioStoreError(path: string, error: unknown): BacklogTaskStoreError {
  return storeError(
    path,
    `Could not read Backlog task data: ${errorMessage(error)}`
  );
}

function storeError(path: string, message: string): BacklogTaskStoreError {
  return new BacklogTaskStoreError({ message, path });
}
