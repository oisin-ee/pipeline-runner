import * as Effect from "effect/Effect";

import { ConfigIoService, parseConfigYamlAs, runConfigIoSync } from "../runtime/services/config-io-service";
import { parseResultWithSchema } from "../schema-boundary";
import {
  PACKAGE_DEFAULT_PIPELINE_YAML,
  PACKAGE_DEFAULT_PROFILES_YAML,
  PACKAGE_DEFAULT_RUNNERS_YAML,
  PIPELINE_CONFIG_PATH,
  PROFILES_CONFIG_PATH,
  RUNNERS_CONFIG_PATH,
} from "./defaults";
import {
  configIssuesFromSchemaIssues,
  pipelineFileSchema,
  profilesFileSchema,
  runnersFileSchema,
  validationError,
} from "./schemas";
import type { PipelineConfig, PipelineConfigParts, PipelineConfigValidationOptions } from "./schemas";
import { validatePipelineConfig } from "./validate";

// PIPE-91.3: structured deprecation diagnostic surfaced when a pipeline.yaml
// still sets the removed durability block. Never swallowed — see detectLegacyPipelineFields.
interface PipelineDeprecationDiagnostic {
  field: string;
  guidance: string;
}

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Returns a diagnostic for each pipeline.yaml key that has been removed.
// Must run against the raw parsed YAML object BEFORE strict schema validation.
const detectLegacyPipelineFields = (raw: unknown): PipelineDeprecationDiagnostic[] => {
  if (!isPlainObject(raw)) {
    return [];
  }
  const diagnostics: PipelineDeprecationDiagnostic[] = [];
  if ("durability" in raw) {
    diagnostics.push({
      field: "durability",
      guidance: "Set momokaya.db.url in ~/.config/moka/config.yaml to enable the durable Postgres substrate.",
    });
  }
  return diagnostics;
};

// Strips legacy fields from the raw YAML object so the strict schema parse succeeds.
const stripLegacyPipelineFields = (raw: unknown, deprecations: PipelineDeprecationDiagnostic[]): unknown => {
  if (deprecations.length === 0 || !isPlainObject(raw)) {
    return raw;
  }
  const stripped: PlainObject = { ...raw };
  for (const { field } of deprecations) {
    delete stripped[field];
  }
  return stripped;
};

type PipelineFile = typeof pipelineFileSchema.Type;
type ProfilesFile = typeof profilesFileSchema.Type;
type RunnersFile = typeof runnersFileSchema.Type;

const warnPipelineDeprecations = (deprecations: PipelineDeprecationDiagnostic[]): void => {
  for (const diag of deprecations) {
    console.warn(`[pipeline] '${diag.field}' is no longer supported and has been ignored. ${diag.guidance}`);
  }
};

const parsePipelineFileEffect = (
  source: string,
  sourcePath: string,
): Effect.Effect<PipelineFile, unknown, ConfigIoService> =>
  Effect.gen(function* effectBody() {
    const configIo = yield* ConfigIoService;
    const rawPipelineObj = yield* configIo.parseYaml(source, sourcePath);
    const pipelineDeprecations = detectLegacyPipelineFields(rawPipelineObj);
    warnPipelineDeprecations(pipelineDeprecations);
    const pipelineParsed = parseResultWithSchema(
      pipelineFileSchema,
      stripLegacyPipelineFields(rawPipelineObj, pipelineDeprecations),
      { onExcessProperty: "error" },
    );
    if (!pipelineParsed.ok) {
      return yield* Effect.fail(validationError(configIssuesFromSchemaIssues(pipelineParsed.issues)));
    }
    return pipelineParsed.value;
  });

const assembledPipelineConfig = (
  pipeline: PipelineFile,
  profiles: ProfilesFile,
  runners: RunnersFile,
): PipelineConfig => ({
  ...(pipeline.context_handoff ? { context_handoff: pipeline.context_handoff } : {}),
  default_workflow: pipeline.default_workflow,
  ...(pipeline.delivery ? { delivery: pipeline.delivery } : {}),
  entrypoints: pipeline.entrypoints,
  hooks: pipeline.hooks,
  ...(profiles.mcp_gateway ? { mcp_gateway: profiles.mcp_gateway } : {}),
  mcp_servers: profiles.mcp_servers,
  ...(pipeline.orchestrator ? { orchestrator: pipeline.orchestrator } : {}),
  ...(pipeline.parallel_worktrees ? { parallel_worktrees: pipeline.parallel_worktrees } : {}),
  profiles: profiles.profiles,
  ...(pipeline.repo_map ? { repo_map: pipeline.repo_map } : {}),
  rules: profiles.rules,
  runner_command: pipeline.runner_command,
  runners: runners.runners,
  scheduler: pipeline.scheduler,
  schedules: pipeline.schedules,
  skills: profiles.skills,
  ...(pipeline.task_context ? { task_context: pipeline.task_context } : {}),
  token_budget: pipeline.token_budget,
  version: 1,
  workflows: pipeline.workflows,
});

const parsePipelineConfigPartsEffect = (
  sources: PipelineConfigParts,
  projectRoot = "",
  sourcePaths: PipelineConfigParts,
  options: PipelineConfigValidationOptions,
) =>
  Effect.gen(function* effectBody() {
    const runners = yield* parseConfigYamlAs(sources.runners, sourcePaths.runners, runnersFileSchema);
    const profiles = yield* parseConfigYamlAs(sources.profiles, sourcePaths.profiles, profilesFileSchema);
    const pipeline = yield* parsePipelineFileEffect(sources.pipeline, sourcePaths.pipeline);
    return validatePipelineConfig(assembledPipelineConfig(pipeline, profiles, runners), projectRoot, options);
  });

export const loadPackagePipelineConfig = (
  projectRoot: string,
  options: PipelineConfigValidationOptions = {},
): PipelineConfig => {
  const program = parsePipelineConfigPartsEffect(
    {
      pipeline: PACKAGE_DEFAULT_PIPELINE_YAML,
      profiles: PACKAGE_DEFAULT_PROFILES_YAML,
      runners: PACKAGE_DEFAULT_RUNNERS_YAML,
    },
    projectRoot,
    {
      pipeline: "@oisincoveney/pipeline/defaults/pipeline.yaml",
      profiles: "@oisincoveney/pipeline/defaults/profiles.yaml",
      runners: "@oisincoveney/pipeline/defaults/runners.yaml",
    },
    options,
  );
  return runConfigIoSync(program);
};

export const loadPipelineConfig = (
  projectRoot: string,
  options: PipelineConfigValidationOptions = {},
): PipelineConfig => loadPackagePipelineConfig(projectRoot, options);

export const parsePipelineConfigParts = (
  sources: PipelineConfigParts,
  projectRoot?: string,
  sourcePaths: PipelineConfigParts = {
    pipeline: PIPELINE_CONFIG_PATH,
    profiles: PROFILES_CONFIG_PATH,
    runners: RUNNERS_CONFIG_PATH,
  },
  options: PipelineConfigValidationOptions = {},
): PipelineConfig => {
  const program = parsePipelineConfigPartsEffect(sources, projectRoot, sourcePaths, options);
  return runConfigIoSync(program);
};

export const parsePipelineConfigYaml = (
  source: string,
  sourcePath = PIPELINE_CONFIG_PATH,
  projectRoot?: string,
): PipelineConfig =>
  parsePipelineConfigParts(
    {
      pipeline: source,
      profiles: "version: 1\nprofiles: {}\n",
      runners: "version: 1\nrunners: {}\n",
    },
    projectRoot,
    {
      pipeline: sourcePath,
      profiles: PROFILES_CONFIG_PATH,
      runners: RUNNERS_CONFIG_PATH,
    },
  );
