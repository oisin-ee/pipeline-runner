import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { PipelineConfigError } from "./config";

export const MOKA_GLOBAL_CONFIG_PATH = ".config/moka/config.yaml";

const mokaSubmitGlobalConfigSchema = z
  .object({
    eventAuthSecretKey: z.string().min(1),
    eventAuthSecretName: z.string().min(1),
    eventUrl: z.string().url(),
    gitCredentialsSecretName: z.string().min(1),
    githubAuthSecretName: z.string().min(1),
    imagePullSecretName: z.string().min(1),
    opencodeAuthSecretName: z.string().min(1),
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
  if (!existsSync(configPath)) {
    return null;
  }

  return parseMokaGlobalConfig(readFileSync(configPath, "utf8"), configPath);
}

export function parseMokaGlobalConfig(
  source: string,
  sourcePath: string
): MokaGlobalConfig {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PipelineConfigError(
      "PIPELINE_CONFIG_PARSE_ERROR",
      `Failed to parse ${sourcePath}`,
      document.errors.map((err) => ({
        message: err.message,
        path: sourcePath,
      }))
    );
  }

  const parsed = mokaGlobalConfigSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new PipelineConfigError(
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
    );
  }

  return parsed.data;
}
