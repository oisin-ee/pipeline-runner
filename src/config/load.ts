import { Effect } from "effect";
import type { z } from "zod";
import {
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
  type PipelineConfig,
  type PipelineConfigParts,
  type PipelineConfigValidationOptions,
  pipelineFileSchema,
  profilesFileSchema,
  runnersFileSchema,
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

// PIPE-83: thread the opt-in architecture-hardening blocks from pipeline.yaml
// into the resolved config so real runs (not just injected-config tests) honour
// them. Without this they were unreachable from a normal config load.
function pipe83Fields(
  pipeline: z.infer<typeof pipelineFileSchema>
): Partial<PipelineConfig> {
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
  const program = parsePipelineConfigPartsEffect(
    sources,
    projectRoot,
    sourcePaths,
    options
  );
  return runConfigIoSync(program);
}

function parsePipelineConfigPartsEffect(
  sources: PipelineConfigParts,
  projectRoot: string | undefined,
  sourcePaths: PipelineConfigParts,
  options: PipelineConfigValidationOptions
) {
  return Effect.gen(function* () {
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
    const pipeline = yield* parseConfigYamlAs(
      sources.pipeline,
      sourcePaths.pipeline,
      pipelineFileSchema
    );
    return validatePipelineConfig(
      {
        default_workflow: pipeline.default_workflow,
        ...durabilityField(pipeline.durability),
        ...pipe83Fields(pipeline),
        entrypoints: pipeline.entrypoints,
        hooks: pipeline.hooks,
        ...(profiles.mcp_gateway ? { mcp_gateway: profiles.mcp_gateway } : {}),
        mcp_servers: profiles.mcp_servers,
        ...(pipeline.orchestrator
          ? { orchestrator: pipeline.orchestrator }
          : {}),
        profiles: profiles.profiles,
        runner_command: pipeline.runner_command,
        rules: profiles.rules,
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
}
