import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ConfigIoService,
  parseConfigYamlAs,
  runConfigIoSync,
} from "../runtime/services/config-io-service";
import {
  mutableArray,
  nonEmptyMutableArray,
  requiredString,
  urlString,
  struct,
} from "../schema-boundary";

export const PIPELINE_CONFIG_PATH = ".pipeline/pipeline.yaml";
export const RUNNERS_CONFIG_PATH = ".pipeline/runners.yaml";
export const PROFILES_CONFIG_PATH = ".pipeline/profiles.yaml";
export const OPENCODE_ECOSYSTEM_MANIFEST_PATH =
  "defaults/opencode-ecosystem.yaml";

const DEFAULT_PACKAGE_DEFAULTS_ROOT = new URL(
  "../../defaults/",
  import.meta.url
);

const loadDefaultYamlEffect = Effect.fn("loadDefaultYaml")(
  function* loadDefaultYamlEffect(filename: string) {
    const configIo = yield* ConfigIoService;
    return yield* configIo.readText(
      new URL(filename, DEFAULT_PACKAGE_DEFAULTS_ROOT)
    );
  }
);

const loadDefaultYaml = (filename: string): string =>
  runConfigIoSync(loadDefaultYamlEffect(filename));

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

const ecosystemStringArraySchema = mutableArray(requiredString);

const ecosystemRuntimeSchema = struct({
  compatibility_runners: ecosystemStringArraySchema,
  default_runner: Schema.Literal("opencode"),
  default_stack_direct: Schema.Literal(true),
  state_authority: Schema.Literal("pipeline"),
});

const ecosystemDependencySchema = struct({
  dependency_scope: requiredString,
  id: requiredString,
  package: requiredString,
  role: requiredString,
  source: urlString,
});

const ecosystemCodeSchema = struct({
  default_stack: Schema.Literal(true),
  id: requiredString,
  name: requiredString,
  package: Schema.optional(requiredString),
  plugin: Schema.optional(
    Schema.Union([
      struct({
        kind: Schema.Literal("local"),
        source_path: requiredString,
        target_path: requiredString,
      }),
      struct({
        kind: Schema.Literal("npm"),
        package: requiredString,
      }),
    ])
  ),
  role: requiredString,
  source: urlString,
});

const ecosystemMcpBackendSchema = struct({
  credentials: ecosystemStringArraySchema,
  id: requiredString,
  locality: requiredString,
  name: Schema.optional(requiredString),
  required: Schema.Boolean,
  role: requiredString,
});

const ecosystemProfileResourceSchema = struct({
  id: requiredString,
  path: Schema.optional(requiredString),
  source: Schema.optional(requiredString),
  used_by: ecosystemStringArraySchema,
});

const ecosystemHostCapabilitiesSchema = struct({
  agents: Schema.Literal(true),
  commands: Schema.Literal(true),
  lsp: Schema.Literal(true),
  mcp_servers: Schema.Literal(true),
  permissions: Schema.Literal(true),
  plugins: Schema.Literal(true),
  project_config: Schema.Literal(true),
  skills: Schema.Literal(true),
  subagents: Schema.Literal(true),
});

const ecosystemSourceSchema = struct({
  label: requiredString,
  url: urlString,
});

const openCodeEcosystemManifestSchema = struct({
  ecosystem_code: nonEmptyMutableArray(ecosystemCodeSchema),
  generated_by: Schema.Literal("@oisincoveney/pipeline"),
  host_capabilities: ecosystemHostCapabilitiesSchema,
  mcp_backends: nonEmptyMutableArray(ecosystemMcpBackendSchema),
  official_dependencies: nonEmptyMutableArray(ecosystemDependencySchema),
  prompts: nonEmptyMutableArray(ecosystemProfileResourceSchema),
  runtime: ecosystemRuntimeSchema,
  skills: nonEmptyMutableArray(ecosystemProfileResourceSchema),
  sources: nonEmptyMutableArray(ecosystemSourceSchema),
  version: Schema.Literal(1),
});

export type OpenCodeEcosystemManifest =
  typeof openCodeEcosystemManifestSchema.Type;

export const parseOpenCodeEcosystemManifest = (
  source: string,
  sourcePath = OPENCODE_ECOSYSTEM_MANIFEST_PATH
): OpenCodeEcosystemManifest => {
  const program = parseConfigYamlAs(
    source,
    sourcePath,
    openCodeEcosystemManifestSchema
  );
  return runConfigIoSync(program);
};

const loadDefaultOpenCodeEcosystemManifestEffect = Effect.fn(
  "loadDefaultOpenCodeEcosystemManifest"
)(function* loadDefaultOpenCodeEcosystemManifestEffect() {
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

const loadDefaultOpenCodeEcosystemManifest = (): OpenCodeEcosystemManifest =>
  runConfigIoSync(loadDefaultOpenCodeEcosystemManifestEffect());

export const DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST =
  loadDefaultOpenCodeEcosystemManifest();
