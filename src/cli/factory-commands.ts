import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

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

const createExperimentFlags = {
  db: Flag.boolean("db").pipe(
    Flag.withDescription("include the database surface"),
    Flag.withDefault(true)
  ),
  flavor: Flag.choice("flavor", ["web", "expo-web"]).pipe(
    Flag.withDescription("app flavor"),
    Flag.withDefault("web")
  ),
  infraRepoUrl: Flag.string("infra-repo-url").pipe(
    Flag.withDescription("infra repo the registry entry lands in"),
    Flag.optional
  ),
  name: Flag.string("name").pipe(Flag.withDescription("app name (kebab-case)")),
  org: Flag.string("org").pipe(
    Flag.withDescription("GitHub org for the new repo"),
    Flag.optional
  ),
  previews: Flag.boolean("previews").pipe(
    Flag.withDescription("include per-PR preview environments"),
    Flag.withDefault(true)
  ),
  templateRef: Flag.string("template-ref").pipe(
    Flag.withDescription("template tag/ref (default: latest tag)"),
    Flag.optional
  ),
  templateSrc: Flag.string("template-src").pipe(
    Flag.withDescription("copier template source"),
    Flag.optional
  ),
};

const templateUpdateFlags = {
  infraRepoUrl: Flag.string("infra-repo-url").pipe(
    Flag.withDescription("infra repo used for discovery"),
    Flag.optional
  ),
  org: Flag.string("org").pipe(
    Flag.withDescription("GitHub org the stamped repos live in"),
    Flag.optional
  ),
  repos: Flag.string("repos").pipe(
    Flag.withDescription(
      "comma-separated repo list (skips fleet-registry discovery)"
    ),
    Flag.optional
  ),
  templateMatch: Flag.string("template-match").pipe(
    Flag.withDescription("answers-file _src_path filter for stamp detection"),
    Flag.optional
  ),
  templateRef: Flag.string("template-ref").pipe(
    Flag.withDescription("template tag/ref (default: latest tag)"),
    Flag.optional
  ),
};

const normalizeCreateExperimentFlags = (
  flags: Command.Command.Config.Infer<typeof createExperimentFlags>
): CreateExperimentFlags => ({
  db: flags.db,
  flavor: flags.flavor,
  infraRepoUrl: Option.getOrUndefined(flags.infraRepoUrl),
  name: flags.name,
  org: Option.getOrUndefined(flags.org),
  previews: flags.previews,
  templateRef: Option.getOrUndefined(flags.templateRef),
  templateSrc: Option.getOrUndefined(flags.templateSrc),
});

const normalizeTemplateUpdateFlags = (
  flags: Command.Command.Config.Infer<typeof templateUpdateFlags>
): TemplateUpdateFlags => ({
  infraRepoUrl: Option.getOrUndefined(flags.infraRepoUrl),
  org: Option.getOrUndefined(flags.org),
  repos: Option.getOrUndefined(flags.repos),
  templateMatch: Option.getOrUndefined(flags.templateMatch),
  templateRef: Option.getOrUndefined(flags.templateRef),
});

const hasText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const createExperimentCommand = Command.make(
  "create-experiment",
  createExperimentFlags,
  (rawFlags) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const flags = normalizeCreateExperimentFlags(rawFlags);
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
      },
    })
).pipe(
  Command.withDescription(
    "Birth a fleet experiment: copier-stamp momokaya-template, create+push the org repo, register it in infra's fleet registry"
  )
);

const templateUpdateCommand = Command.make(
  "template-update",
  templateUpdateFlags,
  (rawFlags) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const flags = normalizeTemplateUpdateFlags(rawFlags);
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
      },
    })
).pipe(
  Command.withDescription(
    "Fan copier-update PRs out across repos stamped from momokaya-template"
  )
);

export const createFactoryCommands = () => [
  createExperimentCommand,
  templateUpdateCommand,
];
