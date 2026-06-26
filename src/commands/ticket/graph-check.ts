import type { Command } from "commander";
import { Effect } from "effect";
import type { TicketCommandOptions } from "./shared";
import {
  currentWorktreePath,
  loadTicketGraphEffect,
  runTicketProgram,
  writeLineEffect,
} from "./shared";

interface TicketRootFlags {
  root?: string;
}

function checkTicketGraphEffect(worktreePath: string, flags: TicketRootFlags) {
  return Effect.gen(function* () {
    const loaded = yield* loadTicketGraphEffect(worktreePath, flags.root);
    const dangling = loaded.graph.danglingDependencies;
    yield* writeLineEffect(
      `OK: ticket graph valid (${loaded.scopedIds.length} tickets)`
    );
    if (dangling.length > 0) {
      yield* writeLineEffect(
        `WARN: ${dangling.length} dependency reference(s) point to tasks absent from this backlog (treated as non-blocking): ${dangling.join(
          "; "
        )}`
      );
    }
  });
}

export function registerGraphCheckSubcommand(
  ticketCommand: Command,
  _options: TicketCommandOptions
): void {
  const graphCommand = ticketCommand
    .command("graph")
    .description("Inspect the Backlog ticket dependency graph");

  graphCommand
    .command("check")
    .description("Validate Backlog ticket dependency references and cycles")
    .option("--root <ticket-id>", "limit validation summary to one ticket tree")
    .action((flags: TicketRootFlags) =>
      runTicketProgram(checkTicketGraphEffect(currentWorktreePath(), flags))
    );
}
