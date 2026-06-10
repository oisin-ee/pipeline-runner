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
  "submit",
  "argo",
  "runner-command",
]);

export interface EntrypointCommandFlags {
  eventUrl?: string;
  image?: string;
  imagePullPolicy?: string;
  imagePullSecret?: string;
  kubeconfig?: string;
  namespace?: string;
  orchestrator?: string;
  queueName?: string;
  schedule?: string;
  serviceAccount?: string;
}

export function registerConfiguredEntrypointCommands(
  program: Command,
  config: PipelineConfig,
  runEntrypoint: (
    entrypoint: string,
    task: string,
    opts: EntrypointCommandFlags
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
    const command = program
      .command(id)
      .description(entrypoint.description ?? `Run the ${id} workflow`)
      .argument("<description...>", "task description");
    if ("schedule" in entrypoint) {
      command
        .option("--namespace <namespace>", "Workflow namespace")
        .option("--schedule <path>", "approved schedule YAML to submit")
        .option("--kubeconfig <path>", "kubeconfig path")
        .option("--orchestrator <name>", "runner orchestrator (codex|opencode)")
        .option(
          "--queue-name <name>",
          "Kueue LocalQueue label for Workflow pods"
        )
        .option("--service-account <name>", "Workflow service account")
        .option("--image <image>", "runner image")
        .option("--image-pull-policy <policy>", "runner image pull policy")
        .option("--image-pull-secret <name>", "imagePullSecret name")
        .option("--event-url <url>", "runner event sink URL");
    }
    command.action(
      async (descriptionParts: string[], flags: EntrypointCommandFlags) => {
        await runEntrypoint(id, descriptionParts.join(" "), flags);
      }
    );
    registered.add(id);
    reservedCommands.add(id);
  }
  return registered;
}
