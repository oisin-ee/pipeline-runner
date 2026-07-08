import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { RepoIoServiceLive } from "../../runtime/services/repo-io-service";
import { sequenceTicketBatchesEffect } from "../../tickets/ticket-graph";
import type { TicketCommandOptions } from "./shared";
import {
  currentWorktreePath,
  loadTicketGraphEffect,
  writeLineEffect,
} from "./shared";

interface TicketSequenceFlags {
  plain?: boolean;
  root?: string;
}

const ticketSequenceFlags = {
  plain: Flag.boolean("plain").pipe(
    Flag.withDescription("print plain text output")
  ),
  root: Flag.string("root").pipe(
    Flag.withDescription("sequence one ticket tree"),
    Flag.optional
  ),
};

const normalizeTicketSequenceFlags = (
  flags: Command.Command.Config.Infer<typeof ticketSequenceFlags>
): TicketSequenceFlags => ({
  plain: flags.plain,
  root: Option.getOrUndefined(flags.root),
});

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

export const createSequenceSubcommand = (_options: TicketCommandOptions) =>
  Command.make("sequence", ticketSequenceFlags, (rawFlags) =>
    printTicketSequenceEffect(
      currentWorktreePath(),
      normalizeTicketSequenceFlags(rawFlags)
    )
  ).pipe(
    Command.provide(RepoIoServiceLive),
    Command.withDescription(
      "Print dependency execution batches for Backlog tickets"
    )
  );
