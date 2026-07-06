import { resolve } from "node:path";

import { Effect } from "effect";

import { BUILTIN_PIPE_COMMANDS } from "../commands/pipeline-command";
import { resolvePackageAssetPath } from "../package-assets";
import { FileSystemService, FileSystemServiceLive, runFileSystemSync } from "../runtime/services/file-system-service";
import { standardOutputSchemaNameFromPath } from "../standard-output-schemas";
import type { PipelineConfig } from "./schemas";

type ConfigWorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];

export interface ConfigLintWarning {
  message: string;
  ruleId: string;
}

const lintShadowedEntrypoints = (config: PipelineConfig): ConfigLintWarning[] =>
  Object.keys(config.entrypoints)
    .filter((id) => BUILTIN_PIPE_COMMANDS.has(id))
    .map((id) => ({
      message: `entrypoint '${id}' is shadowed by the builtin subcommand; invoke via 'moka run --entrypoint ${id} ...'`,
      ruleId: "entrypoint-shadowed",
    }));

const pushLintPathRef = (
  refs: ReturnType<typeof lintFileReferences>,
  path: string,
  ref: { path?: string; source_root?: "package" | "project" },
): void => {
  if (ref.path !== undefined && ref.path !== "") {
    refs.push({ path, ref: { ...ref, path: ref.path } });
  }
};

const lintFileReferences = (
  config: PipelineConfig,
): {
  path: string;
  ref: { path: string; source_root?: "package" | "project" };
}[] => {
  const refs: ReturnType<typeof lintFileReferences> = [];
  // Skill bodies are shared harness assets installed from oisin-ee/agent, so a
  // missing skill body is not a config defect and must not produce a
  // missing-file-reference lint warning. Profile instructions and output schemas
  // remain package/project assets and are still linted below.
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    pushLintPathRef(refs, `profiles.${profileId}.instructions.path`, {
      path: profile.instructions.path,
    });
    pushLintPathRef(refs, `profiles.${profileId}.output.schema_path`, {
      path: profile.output?.schema_path,
    });
  }
  return refs;
};

const missingFileReferenceMessage = (path: string, value: string): string => {
  const base = `${path} references missing file '${value}'`;
  if (path.startsWith("skills.") && value.startsWith(".agents/skills/")) {
    return `${base}. Run \`chezmoi apply --refresh-externals always\` to install shared harness skills from oisin-ee/agent.`;
  }
  return base;
};

const missingFileReferenceWarning = (path: string, value: string): ConfigLintWarning => ({
  message: missingFileReferenceMessage(path, value),
  ruleId: "missing-file-reference",
});

const resolveLintPathReference = (
  projectRoot: string,
  ref: { path: string; source_root?: "package" | "project" },
): string => {
  if (ref.source_root === "package") {
    return resolvePackageAssetPath(ref.path);
  }
  return resolve(projectRoot, ref.path);
};

const lintFileReferenceExists = (
  projectRoot: string,
  ref: ReturnType<typeof lintFileReferences>[number],
  exists: (path: string) => Effect.Effect<boolean>,
): Effect.Effect<boolean> => {
  if (standardOutputSchemaNameFromPath(ref.ref.path)) {
    return Effect.succeed(true);
  }
  return exists(resolveLintPathReference(projectRoot, ref.ref));
};

const lintMissingFileReferencesEffect = (
  config: PipelineConfig,
  projectRoot: string,
): Effect.Effect<ConfigLintWarning[], unknown, FileSystemService> =>
  Effect.gen(function* effectBody() {
    const fileSystem = yield* FileSystemService;
    const warnings: ConfigLintWarning[] = [];
    for (const ref of lintFileReferences(config)) {
      const exists = yield* lintFileReferenceExists(projectRoot, ref, fileSystem.exists);
      if (!exists) {
        warnings.push(missingFileReferenceWarning(ref.path, ref.ref.path));
      }
    }
    return warnings;
  });

const lintWorkflowNode = (warnings: ConfigLintWarning[], node: ConfigWorkflowNode): void => {
  if (node.kind === "parallel") {
    if (node.nodes.length === 1) {
      warnings.push({
        message: `node '${node.id}' is a parallel container with only one child; remove the wrapper`,
        ruleId: "singleton-parallel",
      });
    }
    for (const child of node.nodes) {
      lintWorkflowNode(warnings, child);
    }
  }
};

const lintWorkflowNodes = (config: PipelineConfig): ConfigLintWarning[] => {
  const warnings: ConfigLintWarning[] = [];
  for (const workflow of Object.values(config.workflows)) {
    for (const node of workflow.nodes) {
      lintWorkflowNode(warnings, node);
    }
  }
  return warnings;
};

const lintPipelineConfigEffect = (
  config: PipelineConfig,
  projectRoot: string,
): Effect.Effect<ConfigLintWarning[], unknown, FileSystemService> =>
  Effect.gen(function* effectBody() {
    const missingFiles = yield* lintMissingFileReferencesEffect(config, projectRoot);
    return [...lintShadowedEntrypoints(config), ...missingFiles, ...lintWorkflowNodes(config)];
  });

export const lintPipelineConfig = (config: PipelineConfig, projectRoot: string): ConfigLintWarning[] =>
  runFileSystemSync(lintPipelineConfigEffect(config, projectRoot), FileSystemServiceLive);

export const formatConfigLintWarning = (warning: ConfigLintWarning): string =>
  `WARN ${warning.ruleId}: ${warning.message}`;
