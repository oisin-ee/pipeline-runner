import { Command } from "effect/unstable/cli";

import { createCompleteSubcommand } from "./ticket/complete";
import { createCreateSubcommand } from "./ticket/create";
import { createGraphCheckSubcommand } from "./ticket/graph-check";
import { createNextSubcommand } from "./ticket/next";
import { createSequenceSubcommand } from "./ticket/sequence";
import type { TicketCommandOptions } from "./ticket/shared";
import { createStartSubcommand } from "./ticket/start";

export type { TicketCommandOptions } from "./ticket/shared";

export const createTicketCommand = (options: TicketCommandOptions = {}) =>
  Command.make("ticket").pipe(
    Command.withDescription(
      "Scope, inspect, and select Backlog tickets for moka runs"
    ),
    Command.withSubcommands([
      createGraphCheckSubcommand(options),
      createSequenceSubcommand(options),
      createNextSubcommand(options),
      createStartSubcommand(options),
      createCreateSubcommand(options),
      createCompleteSubcommand(options),
    ])
  );
