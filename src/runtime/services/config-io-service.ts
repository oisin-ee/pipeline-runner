import { existsSync, readFileSync } from "node:fs";

import { Cause, Context, Effect, Layer, Option } from "effect";
import { parseDocument } from "yaml";
import type { z } from "zod";

import {
  configIssuesFromZodError,
  PipelineConfigError,
  validationError,
} from "../../config/schemas";

const parseYamlSource = (source: string, sourcePath: string) => {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_PARSE_ERROR",
      `Failed to parse ${sourcePath}`,
      document.errors.map((err) => ({ message: err.message, path: sourcePath }))
    );
  }
  return document.toJS();
};

export class ConfigIoService extends Context.Service<
  ConfigIoService,
  {
    readonly parseYaml: (
      source: string,
      sourcePath: string
    ) => Effect.Effect<unknown, PipelineConfigError>;
    readonly readOptionalText: (
      path: string
    ) => Effect.Effect<Option.Option<string>>;
    readonly readText: (path: string | URL) => Effect.Effect<string>;
  }
>()("ConfigIoService") {}

const ConfigIoServiceLive = Layer.succeed(ConfigIoService, {
  parseYaml: (source, sourcePath) =>
    Effect.try({
      catch: (error) => error as PipelineConfigError,
      try: () => parseYamlSource(source, sourcePath),
    }),
  readOptionalText: (path) =>
    Effect.sync(() =>
      existsSync(path)
        ? Option.some(readFileSync(path, "utf-8"))
        : Option.none()
    ),
  readText: (path) => Effect.sync(() => readFileSync(path, "utf-8")),
});

export const parseConfigYamlAs = <T extends z.ZodTypeAny>(
  source: string,
  sourcePath: string,
  schema: T
): Effect.Effect<z.infer<T>, PipelineConfigError, ConfigIoService> =>
  Effect.gen(function* effectBody() {
    const configIo = yield* ConfigIoService;
    const yaml = yield* configIo.parseYaml(source, sourcePath);
    const parsed = schema.safeParse(yaml);
    if (!parsed.success) {
      return yield* Effect.fail(
        validationError(configIssuesFromZodError(parsed.error))
      );
    }
    return parsed.data;
  });

export const runConfigIoSync = <A, E>(
  program: Effect.Effect<A, E, ConfigIoService>
): A => {
  const exit = Effect.runSyncExit(Effect.provide(program, ConfigIoServiceLive));
  if (exit._tag === "Success") {
    return exit.value;
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    throw failure.value;
  }
  throw Cause.squash(exit.cause);
};
