import type { Command } from "commander";
import { Effect, Option } from "effect";

import { sequenceTicketBatchesEffect } from "../../tickets/ticket-graph";
import type { TicketCommandOptions } from "./shared";
import {
  currentWorktreePath,
  loadTicketGraphEffect,
  runTicketProgram,
  writeLineEffect,
} from "./shared";

interface TicketSequenceFlags {
  plain?: boolean;
  root?: string;
}

const formatSequence = (batches: readonly (readonly string[])[]): string =>
  batches
    .map((batch, index) =>
      [`Sequence ${index + 1}:`, ...batch.map((id) => `  ${id}`)].join("\n")
    )
    .join("\n\n");

const printTicketSequenceEffect = (
  worktreePath: string,
  flags: TicketSequenceFlags
) =>
  Effect.gen(function* effectBody() {
    const loaded = yield* loadTicketGraphEffect(
      worktreePath,
      Option.fromUndefinedOr(flags.root)
    );
    const batches = yield* sequenceTicketBatchesEffect(
      loaded.graph,
      loaded.scopedIds
    );
    yield* writeLineEffect(formatSequence(batches));
  });

export const registerSequenceSubcommand = (
  ticketCommand: Command,
  _options: TicketCommandOptions
): void => {
  ticketCommand
    .command("sequence")
    .description("Print dependency execution batches for Backlog tickets")
    .option("--root <ticket-id>", "sequence one ticket tree")
    .option("--plain", "print plain text output")
    .action(async (flags: TicketSequenceFlags) => {
      await runTicketProgram(
        printTicketSequenceEffect(currentWorktreePath(), flags)
      );
    });
};
