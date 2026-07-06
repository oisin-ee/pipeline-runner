import { Data, Effect, Option } from "effect";

import { parseBacklogTaskId } from "../backlog";
import { BacklogService } from "../runtime/services/backlog-service";
import type { BacklogCommandError } from "../runtime/services/backlog-service";
import type { TicketPlan } from "./ticket-plan";
import { formatBacklogCommand, ticketCreateArgs } from "./ticket-plan-command-args";

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

const formatCreatedIds = (createdIds: readonly string[]): string =>
  createdIds.length > 0 ? createdIds.join(", ") : "none";

const commandFailure = (
  args: readonly string[],
  createdIds: readonly string[],
  error: BacklogCommandError,
): ApplyTicketPlanError =>
  new ApplyTicketPlanError({
    command: formatBacklogCommand(args),
    createdIds,
    message: `backlog command failed after created ids: ${formatCreatedIds(createdIds)}; failed command: ${formatBacklogCommand(args)}; ${error.message}`,
    stdout: error.stdout,
  });

const runCreateAndParseId = (
  args: readonly string[],
  worktreePath: string,
  backlog: typeof BacklogService.Service,
  createdIds: string[],
): Effect.Effect<string, ApplyTicketPlanError> =>
  Effect.gen(function* effectBody() {
    const stdout = yield* backlog
      .run(args, worktreePath)
      .pipe(Effect.mapError((error) => commandFailure(args, createdIds, error)));
    const taskId = parseBacklogTaskId(stdout);
    if (Option.isNone(taskId)) {
      return yield* Effect.fail(
        new ApplyTicketPlanError({
          command: formatBacklogCommand(args),
          createdIds,
          message: `could not parse created task id from Backlog output; created ids: ${formatCreatedIds(createdIds)}; failed command: ${formatBacklogCommand(args)}`,
          stdout,
        }),
      );
    }
    createdIds.push(taskId.value);
    return taskId.value;
  });

const resolveParentId = (
  plan: TicketPlan,
  options: ApplyTicketPlanOptions,
  worktreePath: string,
  backlog: typeof BacklogService.Service,
  createdIds: string[],
): Effect.Effect<string, ApplyTicketPlanError> => {
  if (options.parentId !== undefined && options.parentId.length > 0) {
    return Effect.succeed(options.parentId);
  }
  if (plan.epic === undefined) {
    return Effect.fail(
      new ApplyTicketPlanError({
        createdIds,
        message: "Cannot apply ticket plan without --parent because the plan does not include an epic.",
      }),
    );
  }
  return runCreateAndParseId(ticketCreateArgs(plan.epic), worktreePath, backlog, createdIds);
};

const createChildTickets = (
  plan: TicketPlan,
  parentId: string,
  worktreePath: string,
  backlog: typeof BacklogService.Service,
  createdIds: string[],
): Effect.Effect<Record<string, string>, ApplyTicketPlanError> =>
  Effect.gen(function* effectBody() {
    const remaining = new Map(plan.tickets.map((ticket) => [ticket.key, ticket]));
    const taskIdsByKey: Record<string, string> = {};
    while (remaining.size > 0) {
      const ready = [...remaining.values()].filter((ticket) => ticket.depends_on.every((key) => taskIdsByKey[key]));
      if (ready.length === 0) {
        return yield* Effect.fail(
          new ApplyTicketPlanError({
            createdIds,
            message:
              "Cannot apply ticket plan because local dependency keys contain a cycle or unresolved prerequisite.",
          }),
        );
      }
      for (const ticket of ready) {
        const dependencyIds = ticket.depends_on.map((key) => taskIdsByKey[key]);
        const taskId = yield* runCreateAndParseId(
          ticketCreateArgs(ticket, { dependencyIds, parentId }),
          worktreePath,
          backlog,
          createdIds,
        );
        taskIdsByKey[ticket.key] = taskId;
        remaining.delete(ticket.key);
      }
    }
    return taskIdsByKey;
  });

export const applyTicketPlanEffect = (
  plan: TicketPlan,
  worktreePath: string,
  options: ApplyTicketPlanOptions,
): Effect.Effect<AppliedTicketPlan, ApplyTicketPlanError, BacklogService> =>
  Effect.gen(function* effectBody() {
    const backlog = yield* BacklogService;
    const createdIds: string[] = [];
    const parentId = yield* resolveParentId(plan, options, worktreePath, backlog, createdIds);
    const taskIdsByKey = yield* createChildTickets(plan, parentId, worktreePath, backlog, createdIds);
    return { createdIds, parentId, taskIdsByKey };
  });
