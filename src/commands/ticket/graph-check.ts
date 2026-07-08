import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { RepoIoServiceLive } from "../../runtime/services/repo-io-service";
import type { TicketCommandOptions } from "./shared";
import {
  currentWorktreePath,
  loadTicketGraphEffect,
  writeLineEffect,
} from "./shared";

interface TicketRootFlags {
  root?: string;
}

const ticketRootFlags = {
  root: Flag.string("root").pipe(
    Flag.withDescription("limit validation summary to one ticket tree"),
    Flag.optional
  ),
};

const normalizeTicketRootFlags = (
  flags: Command.Command.Config.Infer<typeof ticketRootFlags>
): TicketRootFlags => ({
  root: Option.getOrUndefined(flags.root),
});

const checkTicketGraphEffect = (worktreePath: string, flags: TicketRootFlags) =>
  Effect.gen(function* effectBody() {
    const loaded = yield* loadTicketGraphEffect(
      worktreePath,
      Option.fromUndefinedOr(flags.root)
    );
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

export const createGraphCheckSubcommand = (_options: TicketCommandOptions) => {
  const checkCommand = Command.make("check", ticketRootFlags, (rawFlags) =>
    checkTicketGraphEffect(
      currentWorktreePath(),
      normalizeTicketRootFlags(rawFlags)
    )
  ).pipe(
    Command.provide(RepoIoServiceLive),
    Command.withDescription(
      "Validate Backlog ticket dependency references and cycles"
    )
  );
  return Command.make("graph").pipe(
    Command.withDescription("Inspect the Backlog ticket dependency graph"),
    Command.withSubcommands([checkCommand])
  );
};
