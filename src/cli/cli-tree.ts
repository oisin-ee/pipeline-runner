import type { Command } from "effect/unstable/cli";

export const subcommandsOf = (
  command: Command.Command.Any
): Command.Command.Any[] =>
  command.subcommands.flatMap((group) => [...group.commands]);

export const findSubcommand = (
  command: Command.Command.Any,
  name: string
): Command.Command.Any | undefined =>
  subcommandsOf(command).find((subcommand) => subcommand.name === name);
