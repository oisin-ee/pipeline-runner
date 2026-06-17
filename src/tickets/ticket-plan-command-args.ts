import type { TicketPlanEpic, TicketPlanTask } from "./ticket-plan";

export interface TicketCreateArgsOptions {
  readonly dependencyIds?: readonly string[];
  readonly parentId?: string;
}

export function ticketCreateArgs(
  task: TicketPlanEpic | TicketPlanTask,
  options: TicketCreateArgsOptions = {}
): string[] {
  const dependencyIds = options.dependencyIds ?? localDependencyKeys(task);
  return [
    "task",
    "create",
    task.title,
    ...(options.parentId ? ["--parent", options.parentId] : []),
    "--description",
    task.description,
    ...(task.priority ? ["--priority", task.priority] : []),
    ...dependencyIds.flatMap((dependencyId) => ["--dep", dependencyId]),
    ...task.acceptance_criteria.flatMap((criterion) => [
      "--ac",
      `${criterion.text}; evidence: ${criterion.evidence}`,
    ]),
    "--plan",
    task.plan,
    ...task.references.flatMap((reference) => ["--ref", reference]),
    ...task.likely_files.flatMap((path) => ["--modified-file", path]),
    "--plain",
  ];
}

export function formatBacklogCommand(args: readonly string[]): string {
  return ["backlog", ...args].join(" ");
}

function localDependencyKeys(
  task: TicketPlanEpic | TicketPlanTask
): readonly string[] {
  return "depends_on" in task ? task.depends_on : [];
}
