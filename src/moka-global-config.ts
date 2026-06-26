import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import { brokerAuthOptionSchema } from "./broker-auth";
import { PipelineConfigError } from "./config";
import {
  ConfigIoService,
  runConfigIoSync,
} from "./runtime/services/config-io-service";

export const MOKA_GLOBAL_CONFIG_PATH = ".config/moka/config.yaml";

// PIPE-91.3: global durable-substrate switch. Presence of db.url enables the
// Postgres journal; absence keeps the in-memory scheduler (default, back-compat).
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
