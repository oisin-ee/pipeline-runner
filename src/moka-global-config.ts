import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { PipelineConfigError } from "./config";
import { configIssuesFromZodError, validationError } from "./config/schemas";
import { brokerAuthOptionSchema } from "./credentials/broker";
import { dbAuthOptionSchema } from "./remote/argo/model";
import {
  ConfigIoService,
  runConfigIoSync,
} from "./runtime/services/config-io-service";

export const MOKA_GLOBAL_CONFIG_PATH = ".config/moka/config.yaml";

// PIPE-91.3: global durable-substrate switch. Presence of db.url enables the
// Postgres journal. PIPE-91.18 makes run-control/runtime state require it.
const mokaDbGlobalConfigSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(
        (value) => {
          try {
            return ["postgresql:", "postgres:"].includes(
              new URL(value).protocol
            );
          } catch {
            return false;
          }
        },
        { message: "db.url must use postgresql or postgres protocol" }
      ),
  })
  .strict();

const mokaSubmitGlobalConfigSchema = z
  .object({
    // CLIProxyAPI broker auth for the runner's codex + opencode. The runner
    // authenticates through the broker; the broker owns OAuth refresh / rotation
    // / failover, so there is no bespoke per-tool auth mount.
    brokerAuth: brokerAuthOptionSchema,
    // PIPE-94.3: durable-substrate secret ref so `moka submit` emits MOKA_DB_URL
    // into the runner workflow (same dbAuth the console threads programmatically).
    // Absent → no MOKA_DB_URL, submission still works.
    dbAuth: dbAuthOptionSchema.optional(),
    eventAuthSecretKey: z.string().min(1),
    eventAuthSecretName: z.string().min(1),
    eventUrl: z.string().url(),
    gitCredentialsSecretName: z.string().min(1),
    githubAuthSecretName: z.string().min(1),
    imagePullSecretName: z.string().min(1),
    serviceAccountName: z.string().min(1),
  })
  .strict();

const mokaKubernetesGlobalConfigSchema = z
  .object({
    kubeconfig: z.string().min(1).optional(),
    namespace: z.string().min(1),
  })
  .strict();

export const mokaGlobalConfigSchema = z
  .object({
    momokaya: z
      .object({
        db: mokaDbGlobalConfigSchema.optional(),
        kubernetes: mokaKubernetesGlobalConfigSchema,
        submit: mokaSubmitGlobalConfigSchema,
      })
      .strict(),
  })
  .strict();

export type MokaGlobalConfig = z.infer<typeof mokaGlobalConfigSchema>;

export function mokaGlobalConfigPath(homeDir = homedir()): string {
  return join(homeDir, MOKA_GLOBAL_CONFIG_PATH);
}

export class MokaDbUrlRequiredError extends Error {
  readonly code = "db.url-required";

  constructor() {
    super(
      "db.url-required: momokaya.db.url is required for Moka run-control runtime state. " +
        `Configure momokaya.db.url in ${MOKA_GLOBAL_CONFIG_PATH}.`
    );
    this.name = "MokaDbUrlRequiredError";
  }
}

export function requireMokaDbUrl(
  dbUrl: string | undefined
): Effect.Effect<string, MokaDbUrlRequiredError> {
  if (dbUrl === undefined) {
    return Effect.fail(new MokaDbUrlRequiredError());
  }
  return Effect.succeed(dbUrl);
}

// PIPE-91.12: a NARROW read of just the durable-substrate toggle
// (`momokaya.db.url`) for the run-control store cutover. Non-strict by design so
// the unrelated `momokaya.submit` / `momokaya.kubernetes` sections are ignored,
// NOT validated — a run-control read command must never crash on a field such as
// `submit.brokerAuth`, which has nothing to do with run-control persistence. A
// `db` section that IS present is still validated, so a malformed `db.url`
// surfaces rather than being mistaken for "absent".
const mokaDbUrlReadSchema = z.object({
  momokaya: z.object({ db: mokaDbGlobalConfigSchema.optional() }).optional(),
});

/**
 * Resolve the durable-substrate `db.url` toggle for run-control store selection.
 *
 * Returns the configured Postgres url, or `undefined` when the global config is
 * absent or carries no `db.url`.
 * The whole `momokaya` schema is deliberately NOT validated — only the `db`
 * section is — so an unrelated invalid/missing field never breaks run-control
 * reads. A genuine load fault (corrupt YAML, a malformed `db.url`) is surfaced
 * to stderr and returns `undefined`; the required-DB policy then fails at the
 * runtime-state boundary with `db.url-required`.
 */
export function loadMokaDbUrl(): string | undefined {
  // PIPE-94.3: env override — runner pods inject MOKA_DB_URL via secretKeyRef
  // rather than mounting a config file. Check the env var first; fall through to
  // the YAML read for the local-operator path.
  const envUrl = process.env.MOKA_DB_URL;
  if (envUrl !== undefined) {
    const parsed = mokaDbGlobalConfigSchema.safeParse({ url: envUrl });
    if (!parsed.success) {
      process.stderr.write(
        `run-control: MOKA_DB_URL is invalid: ${parsed.error.message}\n`
      );
      return;
    }
    return parsed.data.url;
  }

  const configPath = mokaGlobalConfigPath();
  const program = Effect.gen(function* () {
    const configIo = yield* ConfigIoService;
    const source = yield* configIo.readOptionalText(configPath);
    if (source === null) {
      return;
    }
    const yaml = yield* configIo.parseYaml(source, configPath);
    const parsed = mokaDbUrlReadSchema.safeParse(yaml);
    if (!parsed.success) {
      return yield* Effect.fail(
        validationError(configIssuesFromZodError(parsed.error))
      );
    }
    return parsed.data.momokaya?.db?.url;
  });
  try {
    return runConfigIoSync(program);
  } catch (error) {
    process.stderr.write(
      `run-control: ignoring unreadable ${configPath} for db.url resolution: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return;
  }
}

export function loadMokaGlobalConfig(): MokaGlobalConfig | null {
  const configPath = mokaGlobalConfigPath();
  const program = Effect.gen(function* () {
    const configIo = yield* ConfigIoService;
    const source = yield* configIo.readOptionalText(configPath);
    return source === null
      ? null
      : yield* parseMokaGlobalConfigEffect(source, configPath);
  });
  return runConfigIoSync(program);
}

export function parseMokaGlobalConfig(
  source: string,
  sourcePath: string
): MokaGlobalConfig {
  const program = parseMokaGlobalConfigEffect(source, sourcePath);
  return runConfigIoSync(program);
}

function parseMokaGlobalConfigEffect(source: string, sourcePath: string) {
  return Effect.gen(function* () {
    const configIo = yield* ConfigIoService;
    const yaml = yield* configIo.parseYaml(source, sourcePath);
    const parsed = mokaGlobalConfigSchema.safeParse(yaml);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      return yield* Effect.fail(
        new PipelineConfigError(
          "PIPELINE_CONFIG_VALIDATION_ERROR",
          [
            `Invalid ${sourcePath}:`,
            ...issues.map((issue) =>
              issue.path
                ? `- ${issue.path}: ${issue.message}`
                : `- ${issue.message}`
            ),
          ].join("\n"),
          issues
        )
      );
    }

    return parsed.data;
  });
}
