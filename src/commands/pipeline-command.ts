import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

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

const entrypointBaseConfig = {
  descriptionParts: Argument.string("description").pipe(
    Argument.withDescription("task description"),
    Argument.variadic({ min: 1 })
  ),
};

const scheduledEntrypointConfig = {
  ...entrypointBaseConfig,
  eventUrl: Flag.string("event-url").pipe(
    Flag.withDescription("runner event sink URL"),
    Flag.optional
  ),
  image: Flag.string("image").pipe(
    Flag.withDescription("runner image"),
    Flag.optional
  ),
  imagePullPolicy: Flag.string("image-pull-policy").pipe(
    Flag.withDescription("runner image pull policy"),
    Flag.optional
  ),
  imagePullSecret: Flag.string("image-pull-secret").pipe(
    Flag.withDescription("imagePullSecret name"),
    Flag.optional
  ),
  kubeconfig: Flag.string("kubeconfig").pipe(
    Flag.withDescription("kubeconfig path"),
    Flag.optional
  ),
  namespace: Flag.string("namespace").pipe(
    Flag.withDescription("Workflow namespace"),
    Flag.optional
  ),
  schedule: Flag.string("schedule").pipe(
    Flag.withDescription("approved schedule YAML to submit"),
    Flag.optional
  ),
  serviceAccount: Flag.string("service-account").pipe(
    Flag.withDescription("Workflow service account"),
    Flag.optional
  ),
};

const scheduledEntrypointFlags = (
  flags: Command.Command.Config.Infer<typeof scheduledEntrypointConfig>
): EntrypointCommandFlags => ({
  eventUrl: Option.getOrUndefined(flags.eventUrl),
  image: Option.getOrUndefined(flags.image),
  imagePullPolicy: Option.getOrUndefined(flags.imagePullPolicy),
  imagePullSecret: Option.getOrUndefined(flags.imagePullSecret),
  kubeconfig: Option.getOrUndefined(flags.kubeconfig),
  namespace: Option.getOrUndefined(flags.namespace),
  schedule: Option.getOrUndefined(flags.schedule),
  serviceAccount: Option.getOrUndefined(flags.serviceAccount),
});

const createEntrypointCommand = (
  id: string,
  entrypoint: PipelineConfig["entrypoints"][string],
  runEntrypoint: EntrypointRunner
) => {
  if ("schedule" in entrypoint) {
    return Command.make(id, scheduledEntrypointConfig, (flags) =>
      Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          await runEntrypoint(
            id,
            [...flags.descriptionParts].join(" "),
            scheduledEntrypointFlags(flags)
          );
        },
      })
    ).pipe(
      Command.withDescription(
        entrypoint.description ?? `Run the ${id} workflow`
      )
    );
  }
  return Command.make(id, entrypointBaseConfig, (flags) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        await runEntrypoint(id, [...flags.descriptionParts].join(" "), {});
      },
    })
  ).pipe(
    Command.withDescription(entrypoint.description ?? `Run the ${id} workflow`)
  );
};

export const createConfiguredEntrypointCommands = (
  config: PipelineConfig,
  runEntrypoint: EntrypointRunner,
  reservedCommandNames: ReadonlySet<string>
) => {
  const registered = new Set<string>();
  const reservedCommands = new Set(reservedCommandNames);
  const commands = Object.entries(config.entrypoints).flatMap(
    ([id, entrypoint]) => {
      if (reservedCommands.has(id)) {
        return [];
      }
      reservedCommands.add(id);
      registered.add(id);
      return [createEntrypointCommand(id, entrypoint, runEntrypoint)];
    }
  );
  return { commands, names: registered };
};
