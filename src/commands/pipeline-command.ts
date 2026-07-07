import type { Command } from "commander";
import { Context, Effect, Layer } from "effect";

import type { PipelineConfig } from "../config";

export const BUILTIN_PIPE_COMMANDS = new Set([
  "run",
  "validate",
  "explain-plan",
  "doctor",
  "init",
  "mcp",
  "submit",
  "argo",
  "runner-command",
  "ticket",
  "create-experiment",
  "template-update",
]);

interface EntrypointCommandFlags {
  eventUrl?: string;
  image?: string;
  imagePullPolicy?: string;
  imagePullSecret?: string;
  kubeconfig?: string;
  namespace?: string;
  schedule?: string;
  serviceAccount?: string;
}

type EntrypointRunner = (
  entrypoint: string,
  task: string,
  opts: EntrypointCommandFlags
) => Promise<void>;

class EntrypointCommandService extends Context.Service<
  EntrypointCommandService,
  {
    readonly runEntrypoint: (
      entrypoint: string,
      task: string,
      opts: EntrypointCommandFlags
    ) => Effect.Effect<void, unknown>;
  }
>()("EntrypointCommandService") {}

const createEntrypointCommandServiceLive = (runEntrypoint: EntrypointRunner) =>
  Layer.succeed(EntrypointCommandService, {
    runEntrypoint: (entrypoint, task, opts) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await runEntrypoint(entrypoint, task, opts);
        },
      }),
  });

const runConfiguredEntrypointCommand = (
  entrypoint: string,
  descriptionParts: string[],
  flags: EntrypointCommandFlags
) =>
  Effect.gen(function* effectBody() {
    const service = yield* EntrypointCommandService;
    yield* service.runEntrypoint(entrypoint, descriptionParts.join(" "), flags);
  });

const addScheduledEntrypointOptions = (command: Command): Command =>
  command
    .option("--namespace <namespace>", "Workflow namespace")
    .option("--schedule <path>", "approved schedule YAML to submit")
    .option("--kubeconfig <path>", "kubeconfig path")
    .option("--service-account <name>", "Workflow service account")
    .option("--image <image>", "runner image")
    .option("--image-pull-policy <policy>", "runner image pull policy")
    .option("--image-pull-secret <name>", "imagePullSecret name")
    .option("--event-url <url>", "runner event sink URL");

const configureEntrypointOptions = (
  command: Command,
  entrypoint: PipelineConfig["entrypoints"][string]
): Command => {
  if ("schedule" in entrypoint) {
    return addScheduledEntrypointOptions(command);
  }
  return command;
};

const createEntrypointCommand = (
  program: Command,
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string]
): Command => {
  const command = program
    .command(id)
    .description(entrypoint.description ?? `Run the ${id} workflow`)
    .argument("<description...>", "task description");
  return configureEntrypointOptions(command, entrypoint);
};

const registerEntrypointAction = (
  command: Command,
  id: string,
  serviceLive: ReturnType<typeof createEntrypointCommandServiceLive>
): void => {
  command.action(
    async (descriptionParts: string[], flags: EntrypointCommandFlags) => {
      await Effect.runPromise(
        Effect.provide(
          runConfiguredEntrypointCommand(id, descriptionParts, flags),
          serviceLive
        )
      );
    }
  );
};

export const registerConfiguredEntrypointCommands = (
  program: Command,
  config: PipelineConfig,
  runEntrypoint: EntrypointRunner
): Set<string> => {
  const registered = new Set<string>();
  const serviceLive = createEntrypointCommandServiceLive(runEntrypoint);

  const reservedCommands = new Set(
    program.commands.map((command) => command.name())
  );
  for (const [id, entrypoint] of Object.entries(config.entrypoints)) {
    if (reservedCommands.has(id)) {
      continue;
    }
    const command = createEntrypointCommand(program, id, entrypoint);
    registerEntrypointAction(command, id, serviceLive);
    registered.add(id);
    reservedCommands.add(id);
  }
  return registered;
};
