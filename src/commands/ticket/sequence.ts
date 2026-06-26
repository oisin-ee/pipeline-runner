import type { Command } from "commander";
import { Effect } from "effect";
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

function formatSequence(batches: readonly (readonly string[])[]): string {
  return batches
    .map((batch, index) =>
      [`Sequence ${index + 1}:`, ...batch.map((id) => `  ${id}`)].join("\n")
    )
    .join("\n\n");
}

function printTicketSequenceEffect(
  worktreePath: string,
  flags: TicketSequenceFlags
) {
  return Effect.gen(function* () {
    const loaded = yield* loadTicketGraphEffect(worktreePath, flags.root);
    const batches = yield* sequenceTicketBatchesEffect(
      loaded.graph,
      loaded.scopedIds
    );
    yield* writeLineEffect(formatSequence(batches));
  });
}

export function registerSequenceSubcommand(
  ticketCommand: Command,
  _options: TicketCommandOptions
): void {
  ticketCommand
    .command("sequence")
    .description("Print dependency execution batches for Backlog tickets")
    .option("--root <ticket-id>", "sequence one ticket tree")
    .option("--plain", "print plain text output")
    .action((flags: TicketSequenceFlags) =>
      runTicketProgram(printTicketSequenceEffect(currentWorktreePath(), flags))
    );
}
