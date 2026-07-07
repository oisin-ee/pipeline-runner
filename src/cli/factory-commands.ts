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

const hasText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

export const registerFactoryCommands = (program: Command): void => {
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
      await runCreateExperiment({
        db: flags.db,
        flavor: flags.flavor,
        ...(hasText(flags.infraRepoUrl)
          ? { infraRepoUrl: flags.infraRepoUrl }
          : {}),
        name: flags.name,
        ...(hasText(flags.org) ? { org: flags.org } : {}),
        previews: flags.previews,
        ...(hasText(flags.templateRef)
          ? { templateRef: flags.templateRef }
          : {}),
        ...(hasText(flags.templateSrc)
          ? { templateSource: flags.templateSrc }
          : {}),
      });
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
        ...(hasText(flags.infraRepoUrl)
          ? { infraRepoUrl: flags.infraRepoUrl }
          : {}),
        ...(hasText(flags.org) ? { org: flags.org } : {}),
        ...(hasText(flags.repos)
          ? {
              repos: flags.repos
                .split(",")
                .map((repo) => repo.trim())
                .filter((repo) => repo.length > 0),
            }
          : {}),
        ...(hasText(flags.templateMatch)
          ? { templateMatch: flags.templateMatch }
          : {}),
        ...(hasText(flags.templateRef)
          ? { templateRef: flags.templateRef }
          : {}),
      });
      const { failed } = summarizeTemplateUpdate(results);

      if (failed > 0) {
        process.exitCode = 1;
      }
    });
};
