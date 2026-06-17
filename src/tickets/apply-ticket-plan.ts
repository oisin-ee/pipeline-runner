import { Data, Effect } from "effect";
import { parseBacklogTaskId } from "../backlog";
import {
  type BacklogCommandError,
  BacklogService,
} from "../runtime/services/backlog-service";
import type { TicketPlan } from "./ticket-plan";
import {
  formatBacklogCommand,
  ticketCreateArgs,
} from "./ticket-plan-command-args";

export interface ApplyTicketPlanOptions {
  readonly parentId?: string;
}

export interface AppliedTicketPlan {
  readonly createdIds: readonly string[];
  readonly parentId: string;
  readonly taskIdsByKey: Readonly<Record<string, string>>;
}

class ApplyTicketPlanError extends Data.TaggedError("ApplyTicketPlanError")<{
  readonly command?: string;
  readonly createdIds: readonly string[];
  readonly message: string;
  readonly stdout?: string;
}> {}

export function applyTicketPlanEffect(
  plan: TicketPlan,
  worktreePath: string,
  options: ApplyTicketPlanOptions
): Effect.Effect<AppliedTicketPlan, ApplyTicketPlanError, BacklogService> {
  return Effect.gen(function* () {
    const backlog = yield* BacklogService;
    const createdIds: string[] = [];
    const parentId = yield* resolveParentId(
      plan,
      options,
      worktreePath,
      backlog,
      createdIds
    );
    const taskIdsByKey = yield* createChildTickets(
      plan,
      parentId,
      worktreePath,
      backlog,
      createdIds
    );
    return { createdIds, parentId, taskIdsByKey };
  });
}

function resolveParentId(
  plan: TicketPlan,
  options: ApplyTicketPlanOptions,
  worktreePath: string,
  backlog: typeof BacklogService.Service,
  createdIds: string[]
): Effect.Effect<string, ApplyTicketPlanError> {
  if (options.parentId) {
    return Effect.succeed(options.parentId);
  }
  if (!plan.epic) {
    return Effect.fail(
      new ApplyTicketPlanError({
        createdIds,
        message:
          "Cannot apply ticket plan without --parent because the plan does not include an epic.",
      })
    );
  }
  return runCreateAndParseId(
    ticketCreateArgs(plan.epic),
    worktreePath,
    backlog,
    createdIds
  );
}

function createChildTickets(
  plan: TicketPlan,
  parentId: string,
  worktreePath: string,
  backlog: typeof BacklogService.Service,
  createdIds: string[]
): Effect.Effect<Record<string, string>, ApplyTicketPlanError> {
  return Effect.gen(function* () {
    const remaining = new Map(
      plan.tickets.map((ticket) => [ticket.key, ticket])
    );
    const taskIdsByKey: Record<string, string> = {};
    while (remaining.size > 0) {
      const ready = [...remaining.values()].filter((ticket) =>
        ticket.depends_on.every((key) => taskIdsByKey[key])
      );
      if (ready.length === 0) {
        return yield* Effect.fail(
          new ApplyTicketPlanError({
            createdIds,
            message:
              "Cannot apply ticket plan because local dependency keys contain a cycle or unresolved prerequisite.",
          })
        );
      }
      for (const ticket of ready) {
        const dependencyIds = ticket.depends_on.map((key) => taskIdsByKey[key]);
        const taskId = yield* runCreateAndParseId(
          ticketCreateArgs(ticket, { dependencyIds, parentId }),
          worktreePath,
          backlog,
          createdIds
        );
        taskIdsByKey[ticket.key] = taskId;
        remaining.delete(ticket.key);
      }
    }
    return taskIdsByKey;
  });
}

function runCreateAndParseId(
  args: readonly string[],
  worktreePath: string,
  backlog: typeof BacklogService.Service,
  createdIds: string[]
): Effect.Effect<string, ApplyTicketPlanError> {
  return Effect.gen(function* () {
    const stdout = yield* backlog
      .run(args, worktreePath)
      .pipe(
        Effect.mapError((error) => commandFailure(args, createdIds, error))
      );
    const taskId = parseBacklogTaskId(stdout);
    if (!taskId) {
      return yield* Effect.fail(
        new ApplyTicketPlanError({
          command: formatBacklogCommand(args),
          createdIds,
          message: `could not parse created task id from Backlog output; created ids: ${formatCreatedIds(createdIds)}; failed command: ${formatBacklogCommand(args)}`,
          stdout,
        })
      );
    }
    createdIds.push(taskId);
    return taskId;
  });
}

function commandFailure(
  args: readonly string[],
  createdIds: readonly string[],
  error: BacklogCommandError
): ApplyTicketPlanError {
  return new ApplyTicketPlanError({
    command: formatBacklogCommand(args),
    createdIds,
    message: `backlog command failed after created ids: ${formatCreatedIds(createdIds)}; failed command: ${formatBacklogCommand(args)}; ${error.message}`,
    stdout: error.stdout,
  });
}

function formatCreatedIds(createdIds: readonly string[]): string {
  return createdIds.length > 0 ? createdIds.join(", ") : "none";
}
