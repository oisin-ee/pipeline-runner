import type { Command } from "commander";
import { Effect, Option } from "effect";

import { BacklogServiceLive } from "../../runtime/services/backlog-service";
import type { BacklogTaskRecord } from "../../tickets/backlog-task-store";
import { selectNextTicket, selectReadyTickets } from "../../tickets/ticket-selection";
import type { TicketCommandOptions } from "./shared";
import {
  claimTicketEffect,
  currentWorktreePath,
  formatNextTicket,
  loadTicketSelectionEffect,
  readyTicketEffect,
  runTicketProgramWithBacklog,
  writeLineEffect,
} from "./shared";

interface TicketNextFlags {
  claim?: boolean;
  includeParents?: boolean;
  json?: boolean;
  root?: string;
  strategy?: string;
}

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
    const { loaded, selectionOptions } = yield* loadTicketSelectionEffect(worktreePath, flags);
    const selected = selectNextTicket(loaded.graph, selectionOptions);
    if (flags.claim === true) {
      const ticket = yield* readyTicketEffect(selected);
      yield* claimTicketEffect(worktreePath, ticket);
      yield* writeLineEffect(`Claimed ${formatNextTicket(Option.some(ticket))}`);
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
        : formatNextTicket(selected),
    );
  });

export const registerNextSubcommand = (ticketCommand: Command, options: TicketCommandOptions): void => {
  ticketCommand
    .command("next")
    .description("Select the next ready Backlog ticket deterministically")
    .option("--root <ticket-id>", "select from one ticket tree")
    .option("--claim", "mark the selected ticket In Progress through Backlog")
    .option("--include-parents", "allow parent tickets in selection results")
    .option("--json", "print machine-readable selection output")
    .option("--strategy <strategy>", "selection strategy: priority, bfs, or dfs")
    .action(async (flags: TicketNextFlags) => {
      await runTicketProgramWithBacklog(
        printNextTicketEffect(currentWorktreePath(), flags),
        options.backlogLayer ?? BacklogServiceLive,
      );
    });
};
