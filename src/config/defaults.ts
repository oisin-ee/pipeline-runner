import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  configIssuesFromZodError,
  PipelineConfigError,
  validationError,
} from "./schemas";

export const PIPELINE_CONFIG_PATH = ".pipeline/pipeline.yaml";
export const RUNNERS_CONFIG_PATH = ".pipeline/runners.yaml";
export const PROFILES_CONFIG_PATH = ".pipeline/profiles.yaml";
export const OPENCODE_ECOSYSTEM_MANIFEST_PATH =
  "defaults/opencode-ecosystem.yaml";

const DEFAULT_PACKAGE_DEFAULTS_ROOT = new URL(
  "../../defaults/",
  import.meta.url
);

function loadDefaultYaml(filename: string): string {
  return readFileSync(new URL(filename, DEFAULT_PACKAGE_DEFAULTS_ROOT), "utf8");
}

export const PACKAGE_DEFAULT_RUNNERS_YAML: string =
  loadDefaultYaml("runners.yaml");

export const PACKAGE_DEFAULT_PROFILES_YAML: string =
  loadDefaultYaml("profiles.yaml");

export const PACKAGE_DEFAULT_PIPELINE_YAML: string =
  loadDefaultYaml("pipeline.yaml");

const DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST_URL = new URL(
  `../../${OPENCODE_ECOSYSTEM_MANIFEST_PATH}`,
  import.meta.url
);

const ecosystemStringArraySchema = z.array(z.string().min(1));

const ecosystemRuntimeSchema = z
  .object({
    compatibility_runners: ecosystemStringArraySchema,
    default_runner: z.literal("opencode"),
    default_stack_direct: z.literal(true),
    state_authority: z.literal("pipeline"),
  })
  .strict();

const ecosystemDependencySchema = z
  .object({
    dependency_scope: z.string().min(1),
    id: z.string().min(1),
    package: z.string().min(1),
    role: z.string().min(1),
    source: z.string().url(),
  })
  .strict();

const ecosystemCodeSchema = z
  .object({
    default_stack: z.literal(true),
    id: z.string().min(1),
    name: z.string().min(1),
    package: z.string().min(1).optional(),
    plugin: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("local"),
            source_path: z.string().min(1),
            target_path: z.string().min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal("npm"),
            package: z.string().min(1),
          })
          .strict(),
      ])
      .optional(),
    role: z.string().min(1),
    source: z.string().url(),
  })
  .strict();

const ecosystemProviderModelOptionsSchema = z
  .object({
    include: ecosystemStringArraySchema,
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]),
    reasoningSummary: z.enum(["auto", "detailed"]),
    store: z.literal(false),
    textVerbosity: z.enum(["low", "medium", "high"]),
  })
  .strict();

const ecosystemProviderModelSchema = z
  .object({
    id: z.string().min(1),
    options: ecosystemProviderModelOptionsSchema,
    provider: z.string().min(1),
    role: z.string().min(1),
  })
  .strict();

const ecosystemMcpBackendSchema = z
  .object({
    credentials: ecosystemStringArraySchema,
    id: z.string().min(1),
    locality: z.string().min(1),
    name: z.string().min(1).optional(),
    required: z.boolean(),
    role: z.string().min(1),
  })
  .strict();

const ecosystemProfileResourceSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    used_by: ecosystemStringArraySchema,
  })
  .strict();

const ecosystemHostCapabilitiesSchema = z
  .object({
    agents: z.literal(true),
    commands: z.literal(true),
    lsp: z.literal(true),
    mcp_servers: z.literal(true),
    permissions: z.literal(true),
    plugins: z.literal(true),
    project_config: z.literal(true),
    skills: z.literal(true),
    subagents: z.literal(true),
  })
  .strict();

const ecosystemSourceSchema = z
  .object({
    label: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

const openCodeEcosystemManifestSchema = z
  .object({
    ecosystem_code: z.array(ecosystemCodeSchema).min(1),
    generated_by: z.literal("@oisincoveney/pipeline"),
    host_capabilities: ecosystemHostCapabilitiesSchema,
    mcp_backends: z.array(ecosystemMcpBackendSchema).min(1),
    official_dependencies: z.array(ecosystemDependencySchema).min(1),
    prompts: z.array(ecosystemProfileResourceSchema).min(1),
    provider_models: z.array(ecosystemProviderModelSchema).min(1),
    runtime: ecosystemRuntimeSchema,
    skills: z.array(ecosystemProfileResourceSchema).min(1),
    sources: z.array(ecosystemSourceSchema).min(1),
    version: z.literal(1),
  })
  .strict();

export type OpenCodeEcosystemManifest = z.infer<
  typeof openCodeEcosystemManifestSchema
>;

export function parseOpenCodeEcosystemManifest(
  source: string,
  sourcePath = OPENCODE_ECOSYSTEM_MANIFEST_PATH
): OpenCodeEcosystemManifest {
  return parseYamlAs(source, sourcePath, openCodeEcosystemManifestSchema);
}

function loadDefaultOpenCodeEcosystemManifest(): OpenCodeEcosystemManifest {
  return parseOpenCodeEcosystemManifest(
    readFileSync(DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST_URL, "utf8")
  );
}

export const DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST =
  loadDefaultOpenCodeEcosystemManifest();

function parseYamlAs<T extends z.ZodTypeAny>(
  source: string,
  sourcePath: string,
  schema: T
): z.infer<T> {
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

  const parsed = schema.safeParse(document.toJS());
  if (!parsed.success) {
    throw validationError(configIssuesFromZodError(parsed.error));
  }
  return parsed.data;
}
