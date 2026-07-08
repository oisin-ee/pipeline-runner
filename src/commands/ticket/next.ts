import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { BacklogServiceLive } from "../../runtime/services/backlog-service";
import { RepoIoServiceLive } from "../../runtime/services/repo-io-service";
import type { BacklogTaskRecord } from "../../tickets/backlog-task-store";
import {
  selectNextTicket,
  selectReadyTickets,
} from "../../tickets/ticket-selection";
import type { TicketCommandOptions } from "./shared";
import {
  claimTicketEffect,
  currentWorktreePath,
  formatNextTicket,
  loadTicketSelectionEffect,
  readyTicketEffect,
  writeLineEffect,
} from "./shared";

interface TicketNextFlags {
  claim?: boolean;
  includeParents?: boolean;
  json?: boolean;
  root?: string;
  strategy?: string;
}

const ticketNextFlags = {
  claim: Flag.boolean("claim").pipe(
    Flag.withDescription("mark the selected ticket In Progress through Backlog")
  ),
  includeParents: Flag.boolean("include-parents").pipe(
    Flag.withDescription("allow parent tickets in selection results")
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("print machine-readable selection output")
  ),
  root: Flag.string("root").pipe(
    Flag.withDescription("select from one ticket tree"),
    Flag.optional
  ),
  strategy: Flag.string("strategy").pipe(
    Flag.withDescription("selection strategy: priority, bfs, or dfs"),
    Flag.optional
  ),
};

const normalizeTicketNextFlags = (
  flags: Command.Command.Config.Infer<typeof ticketNextFlags>
): TicketNextFlags => ({
  claim: flags.claim,
  includeParents: flags.includeParents,
  json: flags.json,
  root: Option.getOrUndefined(flags.root),
  strategy: Option.getOrUndefined(flags.strategy),
});

const ticketJson = (ticket: BacklogTaskRecord) => ({
  acceptanceCriteria: ticket.acceptanceCriteria,
  dependencies: ticket.dependencies,
  description: ticket.description,
  id: ticket.id,
  modifiedFiles: ticket.modifiedFiles,
  ordinal: ticket.ordinal,
  parentTaskId: ticket.parentTaskId,
  priority: ticket.priority,
  references: ticket.references,
  status: ticket.status,
  title: ticket.title,
});

const printNextTicketEffect = (worktreePath: string, flags: TicketNextFlags) =>
  Effect.gen(function* effectBody() {
    const { loaded, selectionOptions } = yield* loadTicketSelectionEffect(
      worktreePath,
      flags
    );
    const selected = selectNextTicket(loaded.graph, selectionOptions);
    if (flags.claim === true) {
      const ticket = yield* readyTicketEffect(selected);
      yield* claimTicketEffect(worktreePath, ticket);
      yield* writeLineEffect(
        `Claimed ${formatNextTicket(Option.some(ticket))}`
      );
      return;
    }
    const ready = selectReadyTickets(loaded.graph, selectionOptions);
    yield* writeLineEffect(
      flags.json === true
        ? JSON.stringify({
            ready: ready.map(ticketJson),
            selected: Option.match(selected, {
              onNone: () => null,
              onSome: (ticket) => ticketJson(ticket),
            }),
          })
        : formatNextTicket(selected)
    );
  });

export const createNextSubcommand = (options: TicketCommandOptions) =>
  Command.make("next", ticketNextFlags, (rawFlags) =>
    printNextTicketEffect(
      currentWorktreePath(),
      normalizeTicketNextFlags(rawFlags)
    )
  ).pipe(
    Command.provide(RepoIoServiceLive),
    Command.provide(options.backlogLayer ?? BacklogServiceLive),
    Command.withDescription(
      "Select the next ready Backlog ticket deterministically"
    )
  );
