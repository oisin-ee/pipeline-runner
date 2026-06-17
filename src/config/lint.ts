import { resolve } from "node:path";
import { Effect } from "effect";
import { BUILTIN_PIPE_COMMANDS } from "../commands/pipeline-command";
import { resolvePackageAssetPath } from "../package-assets";
import {
  FileSystemService,
  FileSystemServiceLive,
  runFileSystemSync,
} from "../runtime/services/file-system-service";
import { standardOutputSchemaNameFromPath } from "../standard-output-schemas";
import type { PipelineConfig } from "./schemas";

type ConfigWorkflowNode = PipelineConfig["workflows"][string]["nodes"][number];

export interface ConfigLintWarning {
  message: string;
  ruleId: string;
}

export function lintPipelineConfig(
  config: PipelineConfig,
  projectRoot: string
): ConfigLintWarning[] {
  return runFileSystemSync(
    lintPipelineConfigEffect(config, projectRoot),
    FileSystemServiceLive
  );
}

function lintPipelineConfigEffect(
  config: PipelineConfig,
  projectRoot: string
): Effect.Effect<ConfigLintWarning[], unknown, FileSystemService> {
  return Effect.gen(function* () {
    const missingFiles = yield* lintMissingFileReferencesEffect(
      config,
      projectRoot
    );
    return [
      ...lintShadowedEntrypoints(config),
      ...missingFiles,
      ...lintWorkflowNodes(config),
    ];
  });
}

function lintShadowedEntrypoints(config: PipelineConfig): ConfigLintWarning[] {
  return Object.keys(config.entrypoints)
    .filter((id) => BUILTIN_PIPE_COMMANDS.has(id))
    .map((id) => ({
      ruleId: "entrypoint-shadowed",
      message: `entrypoint '${id}' is shadowed by the builtin subcommand; invoke via 'moka run --entrypoint ${id} ...'`,
    }));
}

function lintMissingFileReferencesEffect(
  config: PipelineConfig,
  projectRoot: string
): Effect.Effect<ConfigLintWarning[], unknown, FileSystemService> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystemService;
    const warnings: ConfigLintWarning[] = [];
    for (const ref of lintFileReferences(config)) {
      const exists = yield* lintFileReferenceExists(
        projectRoot,
        ref,
        fileSystem.exists
      );
      if (!exists) {
        warnings.push(missingFileReferenceWarning(ref.path, ref.ref.path));
      }
    }
    return warnings;
  });
}

function lintFileReferences(config: PipelineConfig): Array<{
  path: string;
  ref: { path: string; source_root?: "package" | "project" };
}> {
  const refs: ReturnType<typeof lintFileReferences> = [];
  // Skill bodies are install-managed (installed into host dirs by `moka init`),
  // so a missing skill body is not a config defect and must not produce a
  // missing-file-reference lint warning. Profile instructions and output
  // schemas remain package/project assets and are still linted below.
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    pushLintPathRef(refs, `profiles.${profileId}.instructions.path`, {
      path: profile.instructions.path,
    });
    pushLintPathRef(refs, `profiles.${profileId}.output.schema_path`, {
      path: profile.output?.schema_path,
    });
  }
  return refs;
}

function pushLintPathRef(
  refs: ReturnType<typeof lintFileReferences>,
  path: string,
  ref: { path?: string; source_root?: "package" | "project" }
): void {
  if (ref.path) {
    refs.push({ path, ref: { ...ref, path: ref.path } });
  }
}

function lintFileReferenceExists(
  projectRoot: string,
  ref: ReturnType<typeof lintFileReferences>[number],
  exists: (path: string) => Effect.Effect<boolean>
): Effect.Effect<boolean> {
  if (standardOutputSchemaNameFromPath(ref.ref.path)) {
    return Effect.succeed(true);
  }
  return exists(resolveLintPathReference(projectRoot, ref.ref));
}

function missingFileReferenceWarning(
  path: string,
  value: string
): ConfigLintWarning {
  return {
    ruleId: "missing-file-reference",
    message: missingFileReferenceMessage(path, value),
  };
}

function missingFileReferenceMessage(path: string, value: string): string {
  const base = `${path} references missing file '${value}'`;
  if (path.startsWith("skills.") && value.startsWith(".agents/skills/")) {
    return `${base}. Run \`moka init\` to install project-local skills with \`npx --yes skills add oisin-ee/skills\`.`;
  }
  return base;
}

function resolveLintPathReference(
  projectRoot: string,
  ref: { path?: string; source_root?: "package" | "project" } | undefined
): string {
  if (ref?.source_root === "package") {
    return resolvePackageAssetPath(ref.path);
  }
  return resolve(projectRoot, ref?.path ?? "");
}

function lintWorkflowNodes(config: PipelineConfig): ConfigLintWarning[] {
  const warnings: ConfigLintWarning[] = [];
  for (const workflow of Object.values(config.workflows)) {
    for (const node of workflow.nodes) {
      lintWorkflowNode(warnings, node);
    }
  }
  return warnings;
}

function lintWorkflowNode(
  warnings: ConfigLintWarning[],
  node: ConfigWorkflowNode
): void {
  if (node.kind === "parallel") {
    if (node.nodes.length === 1) {
      warnings.push({
        ruleId: "singleton-parallel",
        message: `node '${node.id}' is a parallel container with only one child; remove the wrapper`,
      });
    }
    for (const child of node.nodes) {
      lintWorkflowNode(warnings, child);
    }
  }
}

export function formatConfigLintWarning(warning: ConfigLintWarning): string {
  return `WARN ${warning.ruleId}: ${warning.message}`;
}
