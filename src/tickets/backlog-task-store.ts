import { join } from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import matter from "gray-matter";

import { RepoIoService } from "../runtime/services/repo-io-service";
import {
  mutableArray,
  parseResultWithSchema,
  trimmedRequiredString,
  withDefault,
  struct,
} from "../schema-boundary";
import { indexChildrenByParentId } from "./ticket-task-index";
import { formatSchemaIssues, errorMessage } from "./validation-error-format";

const LINE_RE = /\r?\n/u;
const ACCEPTANCE_ITEM_RE = /^\s*-\s*\[[ xX]\]\s*(?:#?[\w.-]+\s+)?(.+)$/u;
const DESCRIPTION_MARKERS = {
  end: "<!-- SECTION:DESCRIPTION:END -->",
  start: "<!-- SECTION:DESCRIPTION:BEGIN -->",
} as const;
const ACCEPTANCE_MARKERS = {
  end: "<!-- AC:END -->",
  start: "<!-- AC:BEGIN -->",
} as const;

const nonEmptyStringSchema = trimmedRequiredString;

const taskFrontmatterSchema = struct({
  dependencies: withDefault(mutableArray(nonEmptyStringSchema), []),
  id: nonEmptyStringSchema,
  modified_files: withDefault(mutableArray(nonEmptyStringSchema), []),
  ordinal: Schema.optional(Schema.Number),
  parent_task_id: Schema.optional(nonEmptyStringSchema),
  priority: Schema.optional(Schema.Literals(["high", "medium", "low"])),
  references: withDefault(mutableArray(nonEmptyStringSchema), []),
  status: Schema.Literals(["To Do", "In Progress", "Done"]),
  title: nonEmptyStringSchema,
});

type TaskFrontmatter = typeof taskFrontmatterSchema.Type;

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

export class BacklogTaskStoreError extends Data.TaggedError(
  "BacklogTaskStoreError"
)<{
  readonly message: string;
  readonly path?: string;
}> {}

const extractMarkedBlock = (
  content: string,
  markers: { readonly end: string; readonly start: string }
): string => {
  const start = content.indexOf(markers.start);
  if (start === -1) {
    return "";
  }
  const bodyStart = start + markers.start.length;
  const end = content.indexOf(markers.end, bodyStart);
  if (end === -1) {
    return "";
  }
  return content.slice(bodyStart, end).trim();
};

const extractDescription = (content: string): string =>
  extractMarkedBlock(content, DESCRIPTION_MARKERS);

const extractAcceptanceCriteria = (content: string): string[] =>
  extractMarkedBlock(content, ACCEPTANCE_MARKERS)
    .split(LINE_RE)
    .map((line) => ACCEPTANCE_ITEM_RE.exec(line)?.[1]?.trim())
    .filter(
      (criterion): criterion is string =>
        criterion !== undefined && criterion.length > 0
    );

const taskRecordFromDocument = (
  frontmatter: TaskFrontmatter,
  content: string,
  filePath: string
): BacklogTaskRecord => ({
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
});

const storeError = (path: string, message: string): BacklogTaskStoreError =>
  new BacklogTaskStoreError({ message, path });

const decodeFrontmatterEffect = (
  frontmatter: unknown,
  filePath: string
): Effect.Effect<TaskFrontmatter, BacklogTaskStoreError> => {
  const decoded = parseResultWithSchema(taskFrontmatterSchema, frontmatter, {
    onExcessProperty: "preserve",
  });
  if (decoded.ok) {
    return Effect.succeed(decoded.value);
  }
  return Effect.fail(
    storeError(
      filePath,
      `Invalid Backlog task frontmatter in ${filePath}: ${formatSchemaIssues(decoded.issues)}`
    )
  );
};

const parseBacklogTaskMarkdownEffect = (
  source: string,
  filePath: string
): Effect.Effect<BacklogTaskRecord, BacklogTaskStoreError> =>
  Effect.gen(function* effectBody() {
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

const indexTasksByIdEffect = (
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<
  ReadonlyMap<string, BacklogTaskRecord>,
  BacklogTaskStoreError
> => {
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
};

const buildBacklogTaskStoreEffect = (
  tasks: readonly BacklogTaskRecord[]
): Effect.Effect<BacklogTaskStore, BacklogTaskStoreError> =>
  Effect.gen(function* effectBody() {
    const tasksById = yield* indexTasksByIdEffect(tasks);
    const childrenByParentId = indexChildrenByParentId(tasks);
    return { childrenByParentId, tasks, tasksById };
  });

const ioStoreError = (path: string, error: unknown): BacklogTaskStoreError =>
  storeError(path, `Could not read Backlog task data: ${errorMessage(error)}`);

const readBacklogTasksEffect = (
  worktreePath: string
): Effect.Effect<BacklogTaskRecord[], BacklogTaskStoreError, RepoIoService> => {
  const tasksDir = join(worktreePath, "backlog", "tasks");
  return Effect.gen(function* effectBody() {
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
};

export const loadBacklogTaskStoreEffect = (
  worktreePath: string
): Effect.Effect<BacklogTaskStore, BacklogTaskStoreError, RepoIoService> =>
  Effect.gen(function* effectBody() {
    const tasks = yield* readBacklogTasksEffect(worktreePath);
    return yield* buildBacklogTaskStoreEffect(tasks);
  });
