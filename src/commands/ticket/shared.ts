import { Data, Effect, Option } from "effect";
import type { Layer } from "effect";

import type { RunCommand } from "../../cli/run-command";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../../runner";
import { BacklogService } from "../../runtime/services/backlog-service";
import { RepoIoServiceLive } from "../../runtime/services/repo-io-service";
import type { RepoIoService } from "../../runtime/services/repo-io-service";
import { loadBacklogTaskStoreEffect } from "../../tickets/backlog-task-store";
import type {
  BacklogTaskRecord,
  BacklogTaskStoreError,
} from "../../tickets/backlog-task-store";
import {
  buildTicketGraphEffect,
  scopedTicketIds,
} from "../../tickets/ticket-graph";
import type { TicketGraph, TicketGraphError } from "../../tickets/ticket-graph";
import type {
  TicketSelectionOptions,
  TicketSelectionStrategy,
} from "../../tickets/ticket-selection";

export type TicketPlanExecutor = (
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
) => Promise<AgentResult>;

export interface TicketCommandOptions {
  readonly backlogLayer?: Layer.Layer<BacklogService>;
  readonly runCommand?: RunCommand;
  readonly ticketPlanExecutor?: TicketPlanExecutor;
}

export interface LoadedTicketGraph {
  readonly graph: TicketGraph;
  readonly scopedIds: readonly string[];
}

export interface TicketSelectionFlags {
  readonly includeParents?: boolean;
  readonly root?: string;
  readonly strategy?: string;
}

export class TicketCommandError extends Data.TaggedError("TicketCommandError")<{
  readonly message: string;
}> {}

const TICKET_SELECTION_STRATEGY_NAMES = new Set(["priority", "bfs", "dfs"]);

export const currentWorktreePath = (): string =>
  process.env.PIPELINE_TARGET_PATH ?? process.cwd();

export const writeLineEffect = (line: string): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(line);
  });

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const formatNextTicket = (
  ticket: Option.Option<BacklogTaskRecord>
): string =>
  Option.match(ticket, {
    onNone: () => "No ready tickets.",
    onSome: (resolved) => `${resolved.id} - ${resolved.title}`,
  });

export const readyTicketEffect = (
  ticket: Option.Option<BacklogTaskRecord>
): Effect.Effect<BacklogTaskRecord, TicketCommandError> =>
  Option.match(ticket, {
    onNone: () =>
      Effect.fail(new TicketCommandError({ message: "No ready tickets." })),
    onSome: (resolved) => Effect.succeed(resolved),
  });

export const claimTicketEffect = (
  worktreePath: string,
  ticket: BacklogTaskRecord
): Effect.Effect<void, TicketCommandError, BacklogService> =>
  Effect.gen(function* effectBody() {
    const backlog = yield* BacklogService;
    yield* backlog
      .run(
        ["task", "edit", ticket.id, "--status", "In Progress", "--plain"],
        worktreePath
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new TicketCommandError({
              message: `Could not claim ticket '${ticket.id}': ${errorMessage(error)}`,
            })
        )
      );
  });

export const loadTicketGraphEffect = (
  worktreePath: string,
  rootId: Option.Option<string>
): Effect.Effect<
  LoadedTicketGraph,
  BacklogTaskStoreError | TicketGraphError | TicketCommandError,
  RepoIoService
> =>
  Effect.gen(function* effectBody() {
    const store = yield* loadBacklogTaskStoreEffect(worktreePath);
    const graph = yield* buildTicketGraphEffect(store.tasks);
    const scopedIds = Option.match(rootId, {
      onNone: () => scopedTicketIds(graph),
      onSome: (resolved) => scopedTicketIds(graph, resolved),
    });
    if (Option.isSome(rootId) && scopedIds.length === 0) {
      return yield* Effect.fail(
        new TicketCommandError({
          message: `Unknown Backlog ticket '${rootId.value}'`,
        })
      );
    }
    return { graph, scopedIds };
  });

const isTicketSelectionStrategy = (
  strategy: string
): strategy is TicketSelectionStrategy =>
  TICKET_SELECTION_STRATEGY_NAMES.has(strategy);

const parseSelectionStrategyEffect = (
  strategy: Option.Option<string>
): Effect.Effect<
  Option.Option<TicketSelectionStrategy>,
  TicketCommandError
> => {
  if (Option.isNone(strategy)) {
    return Effect.succeed(Option.none());
  }
  return isTicketSelectionStrategy(strategy.value)
    ? Effect.succeed(Option.some(strategy.value))
    : Effect.fail(
        new TicketCommandError({
          message: `Unknown ticket selection strategy '${strategy.value}'; expected priority, bfs, or dfs`,
        })
      );
};

export const loadTicketSelectionEffect = (
  worktreePath: string,
  flags: TicketSelectionFlags
): Effect.Effect<
  { loaded: LoadedTicketGraph; selectionOptions: TicketSelectionOptions },
  BacklogTaskStoreError | TicketGraphError | TicketCommandError,
  RepoIoService
> =>
  Effect.gen(function* effectBody() {
    const rootId = Option.fromUndefinedOr(flags.root);
    const strategy = yield* parseSelectionStrategyEffect(
      Option.fromUndefinedOr(flags.strategy)
    );
    const loaded = yield* loadTicketGraphEffect(worktreePath, rootId);
    return {
      loaded,
      selectionOptions: {
        includeParents: flags.includeParents,
        ...Option.match(rootId, {
          onNone: () => ({}),
          onSome: (resolved) => ({ rootId: resolved }),
        }),
        ...Option.match(strategy, {
          onNone: () => ({}),
          onSome: (resolved) => ({ strategy: resolved }),
        }),
      },
    };
  });

export const runTicketProgram = async <A, E>(
  program: Effect.Effect<A, E, RepoIoService>
) => await Effect.runPromise(Effect.provide(program, RepoIoServiceLive));

export const runTicketProgramWithBacklog = async <A, E>(
  program: Effect.Effect<A, E, RepoIoService | BacklogService>,
  backlogLayer: Layer.Layer<BacklogService>
) =>
  await Effect.runPromise(
    Effect.provide(Effect.provide(program, RepoIoServiceLive), backlogLayer)
  );
