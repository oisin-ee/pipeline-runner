import { parseDocument } from "yaml";
import type { z } from "zod";
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
  type PipelineConfig,
  PipelineConfigError,
  type PipelineConfigParts,
  type PipelineConfigValidationOptions,
  pipelineFileSchema,
  profilesFileSchema,
  runnersFileSchema,
  validationError,
} from "./schemas";
import { validatePipelineConfig } from "./validate";

export function loadPipelineConfig(
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  return loadPackagePipelineConfig(projectRoot, options);
}

export function loadPackagePipelineConfig(
  projectRoot: string,
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  return parsePipelineConfigParts(
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
}

export function parsePipelineConfigYaml(
  source: string,
  sourcePath = PIPELINE_CONFIG_PATH,
  projectRoot?: string
): PipelineConfig {
  return parsePipelineConfigParts(
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
}

// PIPE-83.10: spread the optional durability block only when present, kept as a
// helper so the assembly in parsePipelineConfigParts stays within complexity.
function durabilityField(
  durability: PipelineConfig["durability"]
): Pick<Partial<PipelineConfig>, "durability"> {
  return durability ? { durability } : {};
}

export function parsePipelineConfigParts(
  sources: PipelineConfigParts,
  projectRoot?: string,
  sourcePaths: PipelineConfigParts = {
    pipeline: PIPELINE_CONFIG_PATH,
    profiles: PROFILES_CONFIG_PATH,
    runners: RUNNERS_CONFIG_PATH,
  },
  options: PipelineConfigValidationOptions = {}
): PipelineConfig {
  const runners = parseYamlAs(
    sources.runners,
    sourcePaths.runners,
    runnersFileSchema
  );
  const profiles = parseYamlAs(
    sources.profiles,
    sourcePaths.profiles,
    profilesFileSchema
  );
  const pipeline = parseYamlAs(
    sources.pipeline,
    sourcePaths.pipeline,
    pipelineFileSchema
  );
  return validatePipelineConfig(
    {
      default_workflow: pipeline.default_workflow,
      ...durabilityField(pipeline.durability),
      entrypoints: pipeline.entrypoints,
      hooks: pipeline.hooks,
      ...(profiles.mcp_gateway ? { mcp_gateway: profiles.mcp_gateway } : {}),
      mcp_servers: profiles.mcp_servers,
      ...(pipeline.orchestrator ? { orchestrator: pipeline.orchestrator } : {}),
      profiles: profiles.profiles,
      runner_command: pipeline.runner_command,
      rules: profiles.rules,
      runners: runners.runners,
      scheduler: pipeline.scheduler,
      schedules: pipeline.schedules,
      skills: profiles.skills,
      ...(pipeline.task_context ? { task_context: pipeline.task_context } : {}),
      token_budget: pipeline.token_budget,
      version: 1,
      workflows: pipeline.workflows,
    },
    projectRoot,
    options
  );
}

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
