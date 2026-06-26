import type { Command } from "commander";
import { registerCompleteSubcommand } from "./ticket/complete";
import { registerCreateSubcommand } from "./ticket/create";
import { registerGraphCheckSubcommand } from "./ticket/graph-check";
import { registerNextSubcommand } from "./ticket/next";
import { registerSequenceSubcommand } from "./ticket/sequence";
import type { TicketCommandOptions } from "./ticket/shared";
import { registerStartSubcommand } from "./ticket/start";

export type { TicketCommandOptions } from "./ticket/shared";

type SubcommandRegistrar = (
  ticketCommand: Command,
  options: TicketCommandOptions
) => void;

const SUBCOMMAND_REGISTRARS: readonly SubcommandRegistrar[] = [
  registerGraphCheckSubcommand,
  registerSequenceSubcommand,
  registerNextSubcommand,
  registerStartSubcommand,
  registerCreateSubcommand,
  registerCompleteSubcommand,
];

export function registerTicketCommand(
  program: Command,
  options: TicketCommandOptions = {}
): void {
  const ticketCommand = program
    .command("ticket")
    .description("Scope, inspect, and select Backlog tickets for moka runs");
  for (const registrar of SUBCOMMAND_REGISTRARS) {
    registrar(ticketCommand, options);
  }
}
