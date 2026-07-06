import { existsSync, readFileSync } from "node:fs";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parseDocument } from "yaml";

import { configIssuesFromSchemaIssues, PipelineConfigError, validationError } from "../../config/schemas";
import { throwCauseFailure, unknownErrorMessage } from "../../effect-sync-errors";
import { parseResultWithSchema } from "../../schema-boundary";

const parseYamlSource = (source: string, sourcePath: string) => {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_PARSE_ERROR",
      `Failed to parse ${sourcePath}`,
      document.errors.map((err) => ({ message: err.message, path: sourcePath })),
    );
  }
  return document.toJS();
};

export class ConfigIoService extends Context.Service<
  ConfigIoService,
  {
    readonly parseYaml: (source: string, sourcePath: string) => Effect.Effect<unknown, PipelineConfigError>;
    readonly readOptionalText: (path: string) => Effect.Effect<Option.Option<string>>;
    readonly readText: (path: string | URL) => Effect.Effect<string>;
  }
>()("ConfigIoService") {}

const ConfigIoServiceLive = Layer.succeed(ConfigIoService, {
  parseYaml: (source, sourcePath) =>
    Effect.try({
      catch: (error) =>
        error instanceof PipelineConfigError
          ? error
          : new PipelineConfigError("PIPELINE_CONFIG_PARSE_ERROR", `Failed to parse ${sourcePath}`, [
              {
                message: unknownErrorMessage(error),
                path: sourcePath,
              },
            ]),
      try: () => parseYamlSource(source, sourcePath),
    }),
  readOptionalText: (path) =>
    Effect.sync(() => (existsSync(path) ? Option.some(readFileSync(path, "utf-8")) : Option.none())),
  readText: (path) => Effect.sync(() => readFileSync(path, "utf-8")),
});

export const parseConfigYamlAs = <S extends Schema.ConstraintDecoder<unknown>>(
  source: string,
  sourcePath: string,
  schema: S,
): Effect.Effect<S["Type"], PipelineConfigError, ConfigIoService> =>
  Effect.gen(function* effectBody() {
    const configIo = yield* ConfigIoService;
    const yaml = yield* configIo.parseYaml(source, sourcePath);
    const parsed = parseResultWithSchema(schema, yaml, {
      onExcessProperty: "error",
    });
    if (!parsed.ok) {
      return yield* Effect.fail(validationError(configIssuesFromSchemaIssues(parsed.issues)));
    }
    return parsed.value;
  });

export const runConfigIoSync = <A, E>(program: Effect.Effect<A, E, ConfigIoService>): A => {
  const exit = Effect.runSyncExit(Effect.provide(program, ConfigIoServiceLive));
  if (exit._tag === "Success") {
    return exit.value;
  }
  return throwCauseFailure(exit.cause);
};
