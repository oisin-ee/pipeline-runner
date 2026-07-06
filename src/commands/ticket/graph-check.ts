import type { Command } from "commander";
import { Effect, Option } from "effect";

import type { TicketCommandOptions } from "./shared";
import { currentWorktreePath, loadTicketGraphEffect, runTicketProgram, writeLineEffect } from "./shared";

interface TicketRootFlags {
  root?: string;
}

const checkTicketGraphEffect = (worktreePath: string, flags: TicketRootFlags) =>
  Effect.gen(function* effectBody() {
    const loaded = yield* loadTicketGraphEffect(worktreePath, Option.fromUndefinedOr(flags.root));
    const dangling = loaded.graph.danglingDependencies;
    yield* writeLineEffect(`OK: ticket graph valid (${loaded.scopedIds.length} tickets)`);
    if (dangling.length > 0) {
      yield* writeLineEffect(
        `WARN: ${dangling.length} dependency reference(s) point to tasks absent from this backlog (treated as non-blocking): ${dangling.join(
          "; ",
        )}`,
      );
    }
  });

export const registerGraphCheckSubcommand = (ticketCommand: Command, _options: TicketCommandOptions): void => {
  const graphCommand = ticketCommand.command("graph").description("Inspect the Backlog ticket dependency graph");

  graphCommand
    .command("check")
    .description("Validate Backlog ticket dependency references and cycles")
    .option("--root <ticket-id>", "limit validation summary to one ticket tree")
    .action(async (flags: TicketRootFlags) => {
      await runTicketProgram(checkTicketGraphEffect(currentWorktreePath(), flags));
    });
};
