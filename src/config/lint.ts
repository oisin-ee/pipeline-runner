import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_PIPE_COMMANDS } from "../commands/pipeline-command";
import { resolvePackageAssetPath } from "../package-assets";
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
  return [
    ...lintShadowedEntrypoints(config),
    ...lintMissingFileReferences(config, projectRoot),
    ...lintWorkflowNodes(config),
  ];
}

function lintShadowedEntrypoints(config: PipelineConfig): ConfigLintWarning[] {
  return Object.keys(config.entrypoints)
    .filter((id) => BUILTIN_PIPE_COMMANDS.has(id))
    .map((id) => ({
      ruleId: "entrypoint-shadowed",
      message: `entrypoint '${id}' is shadowed by the builtin subcommand; invoke via 'moka run --entrypoint ${id} ...'`,
    }));
}

function lintMissingFileReferences(
  config: PipelineConfig,
  projectRoot: string
): ConfigLintWarning[] {
  const refs: Array<{
    path: string;
    ref?: { path?: string; source_root?: "package" | "project" };
  }> = [];
  for (const [skillId, skill] of Object.entries(config.skills)) {
    refs.push({ path: `skills.${skillId}.path`, ref: skill });
  }
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    refs.push({
      path: `profiles.${profileId}.instructions.path`,
      ref: { path: profile.instructions.path },
    });
    refs.push({
      path: `profiles.${profileId}.output.schema_path`,
      ref: { path: profile.output?.schema_path },
    });
  }
  return refs.flatMap((ref) => {
    const value = ref.ref?.path;
    if (
      !value ||
      standardOutputSchemaNameFromPath(value) ||
      existsSync(resolveLintPathReference(projectRoot, ref.ref))
    ) {
      return [];
    }
    return [
      {
        ruleId: "missing-file-reference",
        message: missingFileReferenceMessage(ref.path, value),
      },
    ];
  });
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
