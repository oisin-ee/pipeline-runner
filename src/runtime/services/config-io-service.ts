import { existsSync, readFileSync } from "node:fs";
import { Cause, Context, Effect, Layer, Option } from "effect";
import { parseDocument } from "yaml";
import type { z } from "zod";
import {
  configIssuesFromZodError,
  PipelineConfigError,
  validationError,
} from "../../config/schemas";

function parseYamlSource(source: string, sourcePath: string) {
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
}

export class ConfigIoService extends Context.Tag("ConfigIoService")<
  ConfigIoService,
  {
    readonly parseYaml: (
      source: string,
      sourcePath: string
    ) => Effect.Effect<unknown, PipelineConfigError>;
    readonly readOptionalText: (path: string) => Effect.Effect<string | null>;
    readonly readText: (path: string | URL) => Effect.Effect<string>;
  }
>() {}

const ConfigIoServiceLive = Layer.succeed(ConfigIoService, {
  parseYaml: (source, sourcePath) =>
    Effect.try({
      try: () => parseYamlSource(source, sourcePath),
      catch: (error) => error as PipelineConfigError,
    }),
  readOptionalText: (path) =>
    Effect.sync(() => (existsSync(path) ? readFileSync(path, "utf8") : null)),
  readText: (path) => Effect.sync(() => readFileSync(path, "utf8")),
});

export function parseConfigYamlAs<T extends z.ZodTypeAny>(
  source: string,
  sourcePath: string,
  schema: T
): Effect.Effect<z.infer<T>, PipelineConfigError, ConfigIoService> {
  return Effect.gen(function* () {
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
}

export function runConfigIoSync<A, E>(
  program: Effect.Effect<A, E, ConfigIoService>
): A {
  const exit = Effect.runSyncExit(Effect.provide(program, ConfigIoServiceLive));
  if (exit._tag === "Success") {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    throw failure.value;
  }
  throw Cause.squash(exit.cause);
}
