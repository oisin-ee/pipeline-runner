import { Effect } from "effect";
import { z } from "zod";
import {
  ConfigIoService,
  parseConfigYamlAs,
  runConfigIoSync,
} from "../runtime/services/config-io-service";

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
  const program = Effect.gen(function* () {
    const configIo = yield* ConfigIoService;
    return yield* configIo.readText(
      new URL(filename, DEFAULT_PACKAGE_DEFAULTS_ROOT)
    );
  });
  return runConfigIoSync(program);
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
  const program = parseConfigYamlAs(
    source,
    sourcePath,
    openCodeEcosystemManifestSchema
  );
  return runConfigIoSync(program);
}

function loadDefaultOpenCodeEcosystemManifest(): OpenCodeEcosystemManifest {
  const program = Effect.gen(function* () {
    const configIo = yield* ConfigIoService;
    const source = yield* configIo.readText(
      DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST_URL
    );
    return yield* parseConfigYamlAs(
      source,
      OPENCODE_ECOSYSTEM_MANIFEST_PATH,
      openCodeEcosystemManifestSchema
    );
  });
  return runConfigIoSync(program);
}

export const DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST =
  loadDefaultOpenCodeEcosystemManifest();
