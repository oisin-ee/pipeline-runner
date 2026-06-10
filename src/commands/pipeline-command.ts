import type { Command } from "commander";
import type { PipelineConfig } from "../config";

export const BUILTIN_PIPE_COMMANDS = new Set([
  "run",
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
  config: PipelineConfig,
  runEntrypoint: (
    entrypoint: string,
    task: string,
    opts: { local?: boolean }
  ) => Promise<void>
): Set<string> {
  const registered = new Set<string>();

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
      .option("--local", "run locally instead of submitting as a k8s job")
      .action(
        async (descriptionParts: string[], flags: { local?: boolean }) => {
          await runEntrypoint(id, descriptionParts.join(" "), flags);
        }
      );
    registered.add(id);
    reservedCommands.add(id);
  }
  return registered;
}
