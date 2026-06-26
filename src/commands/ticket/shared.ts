import { Data, Effect, type Layer } from "effect";
import type { RunCommand } from "../../cli/run-command";
import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../../runner";
import { BacklogService } from "../../runtime/services/backlog-service";
import {
  type RepoIoService,
  RepoIoServiceLive,
} from "../../runtime/services/repo-io-service";
import {
  type BacklogTaskRecord,
  type BacklogTaskStoreError,
  loadBacklogTaskStoreEffect,
} from "../../tickets/backlog-task-store";
import {
  buildTicketGraphEffect,
  scopedTicketIds,
  type TicketGraph,
  type TicketGraphError,
} from "../../tickets/ticket-graph";
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

const TICKET_SELECTION_STRATEGY_NAMES: readonly string[] = [
  "priority",
  "bfs",
  "dfs",
];

export function currentWorktreePath(): string {
  return process.env.PIPELINE_TARGET_PATH ?? process.cwd();
}

export function writeLineEffect(line: string): Effect.Effect<void> {
  return Effect.sync(() => console.log(line));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatNextTicket(
  ticket: BacklogTaskRecord | undefined
): string {
  return ticket ? `${ticket.id} - ${ticket.title}` : "No ready tickets.";
}

export function readyTicketEffect(
  ticket: BacklogTaskRecord | undefined
): Effect.Effect<BacklogTaskRecord, TicketCommandError> {
  return ticket
    ? Effect.succeed(ticket)
    : Effect.fail(new TicketCommandError({ message: "No ready tickets." }));
}

export function claimTicketEffect(
  worktreePath: string,
  ticket: BacklogTaskRecord
): Effect.Effect<void, TicketCommandError, BacklogService> {
  return Effect.gen(function* () {
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
}

export function loadTicketGraphEffect(
  worktreePath: string,
  rootId: string | undefined
): Effect.Effect<
  LoadedTicketGraph,
  BacklogTaskStoreError | TicketGraphError | TicketCommandError,
  RepoIoService
> {
  return Effect.gen(function* () {
    const store = yield* loadBacklogTaskStoreEffect(worktreePath);
    const graph = yield* buildTicketGraphEffect(store.tasks);
    const scopedIds = scopedTicketIds(graph, rootId);
    if (rootId && scopedIds.length === 0) {
      return yield* Effect.fail(
        new TicketCommandError({
          message: `Unknown Backlog ticket '${rootId}'`,
        })
      );
    }
    return { graph, scopedIds };
  });
}

export function loadTicketSelectionEffect(
  worktreePath: string,
  flags: TicketSelectionFlags
): Effect.Effect<
  { loaded: LoadedTicketGraph; selectionOptions: TicketSelectionOptions },
  BacklogTaskStoreError | TicketGraphError | TicketCommandError,
  RepoIoService
> {
  return Effect.gen(function* () {
    const strategy = yield* parseSelectionStrategyEffect(flags.strategy);
    const loaded = yield* loadTicketGraphEffect(worktreePath, flags.root);
    return {
      loaded,
      selectionOptions: {
        includeParents: flags.includeParents,
        rootId: flags.root,
        strategy,
      },
    };
  });
}

function parseSelectionStrategyEffect(
  strategy: string | undefined
): Effect.Effect<TicketSelectionStrategy | undefined, TicketCommandError> {
  return strategy === undefined || isTicketSelectionStrategy(strategy)
    ? Effect.succeed(strategy)
    : Effect.fail(
        new TicketCommandError({
          message: `Unknown ticket selection strategy '${strategy}'; expected priority, bfs, or dfs`,
        })
      );
}

function isTicketSelectionStrategy(
  strategy: string
): strategy is TicketSelectionStrategy {
  return TICKET_SELECTION_STRATEGY_NAMES.includes(strategy);
}

export function runTicketProgram<A, E>(
  program: Effect.Effect<A, E, RepoIoService>
) {
  return Effect.runPromise(Effect.provide(program, RepoIoServiceLive));
}

export function runTicketProgramWithBacklog<A, E>(
  program: Effect.Effect<A, E, RepoIoService | BacklogService>,
  backlogLayer: Layer.Layer<BacklogService>
) {
  return Effect.runPromise(
    Effect.provide(Effect.provide(program, RepoIoServiceLive), backlogLayer)
  );
}
