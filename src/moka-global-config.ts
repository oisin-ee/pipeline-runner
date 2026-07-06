import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { PipelineConfigError } from "./config";
import { configIssuesFromSchemaIssues } from "./config/schemas";
import { brokerAuthOptionSchema } from "./credentials/broker";
import { throwCauseFailureAsError, unknownErrorMessage } from "./effect-sync-errors";
import { dbAuthOptionSchema, mcpGatewayAuthOptionSchema } from "./remote/argo/model";
import { ConfigIoService, runConfigIoSync } from "./runtime/services/config-io-service";
import { parseResultWithSchema, requiredString, urlString, struct } from "./schema-boundary";

export const MOKA_GLOBAL_CONFIG_PATH = ".config/moka/config.yaml";

const postgresUrlString = urlString.check(
  Schema.makeFilter<string>(
    (value) => {
      if (!URL.canParse(value)) {
        return "must be a valid URL";
      }
      return (
        ["postgresql:", "postgres:"].includes(new URL(value).protocol) ||
        "db.url must use postgresql or postgres protocol"
      );
    },
    {
      description: "Postgres database URL for run-control state.",
      identifier: "MokaPostgresUrlString",
      title: "Moka Postgres URL string",
    },
  ),
);

const mokaDbGlobalConfigSchema = struct({
  url: postgresUrlString,
});

const mokaSubmitGlobalConfigSchema = struct({
  brokerAuth: brokerAuthOptionSchema,
  dbAuth: Schema.optional(dbAuthOptionSchema),
  eventAuthSecretKey: requiredString,
  eventAuthSecretName: requiredString,
  eventUrl: urlString,
  gitCredentialsSecretName: requiredString,
  githubAuthSecretName: requiredString,
  imagePullSecretName: requiredString,
  mcpGatewayAuth: Schema.optional(mcpGatewayAuthOptionSchema),
  npmRegistryAuthSecretName: Schema.optional(requiredString),
  serviceAccountName: requiredString,
});

const mokaKubernetesGlobalConfigSchema = struct({
  context: Schema.optional(requiredString),
  kubeconfig: Schema.optional(requiredString),
  namespace: requiredString,
});

export const mokaGlobalConfigSchema = struct({
  momokaya: struct({
    db: Schema.optional(mokaDbGlobalConfigSchema),
    kubernetes: mokaKubernetesGlobalConfigSchema,
    submit: mokaSubmitGlobalConfigSchema,
  }),
});

export type MokaGlobalConfig = typeof mokaGlobalConfigSchema.Type;
type OptionalString = NodeJS.ProcessEnv[string];

const optionalMokaDbUrlConfig = Config.option(Config.redacted("MOKA_DB_URL"));

const runPathSync = <A, E>(program: Effect.Effect<A, E, Path.Path>): A => {
  const exit = Effect.runSyncExit(
    Effect.provide(Effect.provide(program, Path.layer), ConfigProvider.layer(ConfigProvider.fromEnv())),
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  return throwCauseFailureAsError(exit.cause);
};

const mokaGlobalConfigPathEffect = (homeDir?: string): Effect.Effect<string, Config.ConfigError, Path.Path> =>
  Effect.gen(function* pathEffect() {
    const path = yield* Path.Path;
    const home = homeDir ?? (yield* Config.string("HOME"));
    return path.join(home, MOKA_GLOBAL_CONFIG_PATH);
  });

export const mokaGlobalConfigPath = (homeDir?: string): string => runPathSync(mokaGlobalConfigPathEffect(homeDir));

export class MokaDbUrlRequiredError extends Error {
  readonly code = "db.url-required";

  constructor() {
    super(
      "db.url-required: momokaya.db.url is required for Moka run-control runtime state. " +
        `Configure momokaya.db.url in ${MOKA_GLOBAL_CONFIG_PATH}.`,
    );
    this.name = "MokaDbUrlRequiredError";
  }
}

export const requireMokaDbUrl = (dbUrl: OptionalString): Effect.Effect<string, MokaDbUrlRequiredError> => {
  if (dbUrl === undefined || dbUrl === "") {
    return Effect.fail(new MokaDbUrlRequiredError());
  }
  return Effect.succeed(dbUrl);
};

const mokaDbUrlReadSchema = struct({
  momokaya: Schema.optional(struct({ db: Schema.optional(mokaDbGlobalConfigSchema) })),
});

const globalConfigValidationError = (
  sourcePath: string,
  issues: ReturnType<typeof configIssuesFromSchemaIssues>,
): PipelineConfigError =>
  new PipelineConfigError(
    "PIPELINE_CONFIG_VALIDATION_ERROR",
    [
      `Invalid ${sourcePath}:`,
      ...issues.map((issue) =>
        issue.path !== undefined && issue.path !== "" ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`,
      ),
    ].join("\n"),
    issues,
  );

const loadMokaDbUrlEffect = Effect.fn("loadMokaDbUrl")(function* (configPath: string) {
  const envUrl = yield* optionalMokaDbUrlConfig;
  if (Option.isSome(envUrl)) {
    const url = Redacted.value(envUrl.value);
    const parsed = parseResultWithSchema(mokaDbGlobalConfigSchema, {
      url,
    });
    if (!parsed.ok) {
      process.stderr.write(`run-control: MOKA_DB_URL is invalid: ${parsed.error.message}\n`);
      return undefined;
    }
    return parsed.value.url;
  }

  const configIo = yield* ConfigIoService;
  const source = yield* configIo.readOptionalText(configPath);
  if (Option.isNone(source)) {
    return undefined;
  }
  const yaml = yield* configIo.parseYaml(source.value, configPath);
  const parsed = parseResultWithSchema(mokaDbUrlReadSchema, yaml);
  if (!parsed.ok) {
    return yield* Effect.fail(globalConfigValidationError(configPath, configIssuesFromSchemaIssues(parsed.issues)));
  }
  return parsed.value.momokaya?.db?.url;
});

export const loadMokaDbUrl = (): OptionalString => {
  const configPath = mokaGlobalConfigPath();
  const program = Effect.provide(loadMokaDbUrlEffect(configPath), ConfigProvider.layer(ConfigProvider.fromEnv()));
  return Result.match(runConfigIoSync(Effect.result(program)), {
    onFailure: (error) => {
      process.stderr.write(
        `run-control: ignoring unreadable ${configPath} for db.url resolution: ${unknownErrorMessage(error)}\n`,
      );
      return undefined;
    },
    onSuccess: (url) => url,
  });
};

const parseMokaGlobalConfigEffect = Effect.fn("parseMokaGlobalConfig")(function* (source: string, sourcePath: string) {
  const configIo = yield* ConfigIoService;
  const yaml = yield* configIo.parseYaml(source, sourcePath);
  const parsed = parseResultWithSchema(mokaGlobalConfigSchema, yaml, {
    onExcessProperty: "error",
  });
  if (!parsed.ok) {
    return yield* Effect.fail(globalConfigValidationError(sourcePath, configIssuesFromSchemaIssues(parsed.issues)));
  }

  return parsed.value;
});

export const loadMokaGlobalConfig = () => {
  const configPath = mokaGlobalConfigPath();
  const program = Effect.fn("loadMokaGlobalConfig")(function* () {
    const configIo = yield* ConfigIoService;
    const source = yield* configIo.readOptionalText(configPath);
    return Option.isNone(source) ? null : yield* parseMokaGlobalConfigEffect(source.value, configPath);
  });
  return runConfigIoSync(program());
};

export const parseMokaGlobalConfig = (source: string, sourcePath: string): MokaGlobalConfig => {
  const program = parseMokaGlobalConfigEffect(source, sourcePath);
  return runConfigIoSync(program);
};
