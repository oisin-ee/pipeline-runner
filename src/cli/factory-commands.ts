import type { Command } from "commander";
import { Option } from "commander";
import { runCreateExperiment } from "../factory/create-experiment";
import {
  runTemplateUpdate,
  summarizeTemplateUpdate,
} from "../factory/template-update";

interface CreateExperimentFlags {
  db: boolean;
  flavor: "web" | "expo-web";
  infraRepoUrl?: string;
  name: string;
  org?: string;
  previews: boolean;
  templateRef?: string;
  templateSrc?: string;
}

interface TemplateUpdateFlags {
  infraRepoUrl?: string;
  org?: string;
  repos?: string;
  templateMatch?: string;
  templateRef?: string;
}

export function registerFactoryCommands(program: Command): void {
  program
    .command("create-experiment")
    .description(
      "Birth a fleet experiment: copier-stamp momokaya-template, create+push the org repo, register it in infra's fleet registry"
    )
    .requiredOption("--name <name>", "app name (kebab-case)")
    .addOption(
      new Option("--flavor <flavor>", "app flavor")
        .choices(["web", "expo-web"])
        .default("web")
    )
    .option("--no-db", "skip the database surface")
    .option("--no-previews", "skip per-PR preview environments")
    .option("--org <org>", "GitHub org for the new repo")
    .option("--template-src <source>", "copier template source")
    .option("--template-ref <ref>", "template tag/ref (default: latest tag)")
    .option("--infra-repo-url <url>", "infra repo the registry entry lands in")
    .action(async (flags: CreateExperimentFlags) => {
      const result = await runCreateExperiment({
        db: flags.db,
        flavor: flags.flavor,
        ...(flags.infraRepoUrl ? { infraRepoUrl: flags.infraRepoUrl } : {}),
        name: flags.name,
        ...(flags.org ? { org: flags.org } : {}),
        previews: flags.previews,
        ...(flags.templateRef ? { templateRef: flags.templateRef } : {}),
        ...(flags.templateSrc ? { templateSource: flags.templateSrc } : {}),
      });
      console.log(
        `Experiment born: ${result.repoUrl} (registry ${result.registryPath} @ infra ${result.infraCommitSha})`
      );
    });

  program
    .command("template-update")
    .description(
      "Fan copier-update PRs out across repos stamped from momokaya-template"
    )
    .option(
      "--repos <repos>",
      "comma-separated repo list (skips fleet-registry discovery)"
    )
    .option("--org <org>", "GitHub org the stamped repos live in")
    .option(
      "--template-match <substring>",
      "answers-file _src_path filter for stamp detection"
    )
    .option("--template-ref <ref>", "template tag/ref (default: latest tag)")
    .option("--infra-repo-url <url>", "infra repo used for discovery")
    .action(async (flags: TemplateUpdateFlags) => {
      const { results } = await runTemplateUpdate({
        ...(flags.infraRepoUrl ? { infraRepoUrl: flags.infraRepoUrl } : {}),
        ...(flags.org ? { org: flags.org } : {}),
        ...(flags.repos
          ? {
              repos: flags.repos
                .split(",")
                .map((repo) => repo.trim())
                .filter((repo) => repo.length > 0),
            }
          : {}),
        ...(flags.templateMatch ? { templateMatch: flags.templateMatch } : {}),
        ...(flags.templateRef ? { templateRef: flags.templateRef } : {}),
      });
      const { failed, opened } = summarizeTemplateUpdate(results);
      console.log(
        `template-update: ${opened} PR(s) opened, ${failed} error(s)`
      );
      if (failed > 0) {
        process.exitCode = 1;
      }
    });
}
