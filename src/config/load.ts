import { Effect } from "effect";
import type { z } from "zod";

import {
  ConfigIoService,
  parseConfigYamlAs,
  runConfigIoSync,
} from "../runtime/services/config-io-service";
import {
  PACKAGE_DEFAULT_PIPELINE_YAML,
  PACKAGE_DEFAULT_PROFILES_YAML,
  PACKAGE_DEFAULT_RUNNERS_YAML,
  PIPELINE_CONFIG_PATH,
  PROFILES_CONFIG_PATH,
  RUNNERS_CONFIG_PATH,
} from "./defaults";
import {
  configIssuesFromZodError,
  pipelineFileSchema,
  profilesFileSchema,
  runnersFileSchema,
  validationError,
} from "./schemas";
import type {
  PipelineConfig,
  PipelineConfigParts,
  PipelineConfigValidationOptions,
} from "./schemas";
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
const detectLegacyPipelineFields = (
  raw: unknown
): PipelineDeprecationDiagnostic[] => {
  if (!isPlainObject(raw)) {
    return [];
  }
  const diagnostics: PipelineDeprecationDiagnostic[] = [];
  if ("durability" in raw) {
    diagnostics.push({
      field: "durability",
      guidance:
        "Set momokaya.db.url in ~/.config/moka/config.yaml to enable the durable Postgres substrate.",
    });
  }
  return diagnostics;
};

// Strips legacy fields from the raw YAML object so the strict schema parse succeeds.
const stripLegacyPipelineFields = (
  raw: unknown,
  deprecations: PipelineDeprecationDiagnostic[]
): unknown => {
  if (deprecations.length === 0 || !isPlainObject(raw)) {
    return raw;
  }
  const stripped: PlainObject = { ...raw };
  for (const { field } of deprecations) {
    delete stripped[field];
  }
  return stripped;
};

// PIPE-83: thread the opt-in architecture-hardening blocks from pipeline.yaml
// into the resolved config so real runs (not just injected-config tests) honour
// them. Without this they were unreachable from a normal config load.
const pipe83Fields = (
  pipeline: z.infer<typeof pipelineFileSchema>
): Partial<PipelineConfig> => {
  const keys = [
    "context_handoff",
    "delivery",
    "parallel_worktrees",
    "repo_map",
  ] as const;
  const source = pipeline as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out as Partial<PipelineConfig>;
};

const parsePipelineConfigPartsEffect = (
  sources: PipelineConfigParts,
  projectRoot = "",
  sourcePaths: PipelineConfigParts,
  options: PipelineConfigValidationOptions
) =>
  Effect.gen(function* effectBody() {
    const configIo = yield* ConfigIoService;
    const runners = yield* parseConfigYamlAs(
      sources.runners,
      sourcePaths.runners,
      runnersFileSchema
    );
    const profiles = yield* parseConfigYamlAs(
      sources.profiles,
      sourcePaths.profiles,
      profilesFileSchema
    );
    // PIPE-91.3: parse raw YAML first to detect and strip deprecated fields
    // before strict schema validation, then emit structured deprecation diagnostics.
    const rawPipelineObj = yield* configIo.parseYaml(
      sources.pipeline,
      sourcePaths.pipeline
    );
    const pipelineDeprecations = detectLegacyPipelineFields(rawPipelineObj);
    for (const diag of pipelineDeprecations) {
      console.warn(
        `[pipeline] '${diag.field}' is no longer supported and has been ignored. ${diag.guidance}`
      );
    }
    const strippedPipelineObj = stripLegacyPipelineFields(
      rawPipelineObj,
      pipelineDeprecations
    );
    const pipelineParsed = pipelineFileSchema.safeParse(strippedPipelineObj);
    if (!pipelineParsed.success) {
      return yield* Effect.fail(
        validationError(configIssuesFromZodError(pipelineParsed.error))
      );
    }
    const pipeline = pipelineParsed.data;
    return validatePipelineConfig(
      {
        ...(pipeline.context_handoff
          ? { context_handoff: pipeline.context_handoff }
          : {}),
        default_workflow: pipeline.default_workflow,
        ...(pipeline.delivery ? { delivery: pipeline.delivery } : {}),
        entrypoints: pipeline.entrypoints,
        hooks: pipeline.hooks,
        ...(profiles.mcp_gateway ? { mcp_gateway: profiles.mcp_gateway } : {}),
        mcp_servers: profiles.mcp_servers,
        ...(pipeline.orchestrator
          ? { orchestrator: pipeline.orchestrator }
          : {}),
        ...(pipeline.parallel_worktrees
          ? { parallel_worktrees: pipeline.parallel_worktrees }
          : {}),
        profiles: profiles.profiles,
        ...(pipeline.repo_map ? { repo_map: pipeline.repo_map } : {}),
        rules: profiles.rules,
        runner_command: pipeline.runner_command,
        runners: runners.runners,
        scheduler: pipeline.scheduler,
        schedules: pipeline.schedules,
        skills: profiles.skills,
        ...(pipeline.task_context
          ? { task_context: pipeline.task_context }
          : {}),
        token_budget: pipeline.token_budget,
        version: 1,
        workflows: pipeline.workflows,
      },
      projectRoot,
      options
    );
  });

export const loadPackagePipelineConfig = (
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
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
    options
  );
  return runConfigIoSync(program);
};

export const loadPipelineConfig = (
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig => loadPackagePipelineConfig(projectRoot, options);

export const parsePipelineConfigParts = (
  sources: PipelineConfigParts,
  projectRoot?: string,
  sourcePaths: PipelineConfigParts = {
    pipeline: PIPELINE_CONFIG_PATH,
    profiles: PROFILES_CONFIG_PATH,
    runners: RUNNERS_CONFIG_PATH,
  },
  options: PipelineConfigValidationOptions = {}
): PipelineConfig => {
  const program = parsePipelineConfigPartsEffect(
    sources,
    projectRoot,
    sourcePaths,
    options
  );
  return runConfigIoSync(program);
};

export const parsePipelineConfigYaml = (
  source: string,
  sourcePath = PIPELINE_CONFIG_PATH,
  projectRoot?: string
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
    }
  );
