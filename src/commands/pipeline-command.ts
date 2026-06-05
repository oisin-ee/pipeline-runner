import type { Command } from "commander";
import type { PipelineConfig } from "../config.js";

export const BUILTIN_PIPE_COMMANDS = new Set([
  "run",
  "pipe",
  "validate",
  "explain-plan",
  "doctor",
  "init",
  "install-commands",
  "mcp",
  "runner-job",
]);

export function registerConfiguredEntrypointCommands(
  program: Command,
  config: PipelineConfig | null,
  runEntrypoint: (entrypoint: string, task: string) => Promise<void>
): Set<string> {
  const registered = new Set<string>();
  if (!config) {
    return registered;
  }

  const reservedCommands = new Set(
    program.commands.map((command) => command.name())
  );
  for (const [id, entrypoint] of Object.entries(config.entrypoints)) {
    if (reservedCommands.has(id)) {
      continue;
    }
    program
      .command(id)
      .description(entrypoint.description ?? `Run the ${id} workflow`)
      .argument("<description...>", "task description")
      .action(async (descriptionParts: string[]) => {
        await runEntrypoint(id, descriptionParts.join(" "));
      });
    registered.add(id);
    reservedCommands.add(id);
  }
  return registered;
}
