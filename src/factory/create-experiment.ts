import { existsSync, mkdtempSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_RUNNER_COMMAND_GIT_COMMITTER } from "../config/schema/catalog";
import { resolveFactorySeams } from "./exec";
import type { FactorySeams } from "./exec";
import { githubGitCredentialEnv } from "./git-credentials";

/**
 * create-experiment lane (INFRA-087.12): one deterministic run births a
 * deployable fleet experiment.
 *
 *   1. headless `copier copy` stamps the app tree from momokaya-template;
 *   2. `gh repo create <org>/<name> --private` + authenticated push publish it;
 *   3. the stamped `infra-registry/config/<name>.yaml` is committed to the
 *      infra repo's fleet registry (`k8s/apps/platform-fleet/config/`), where
 *      the platform-fleet chart renders its previews ApplicationSet
 *      (`lifecycle: experiment` renders previews only, no prod Application).
 *
 * Ordered data-driven steps; each failure surfaces with the step name. No
 * automatic rollback: a partially-born experiment is reported, and retirement
 * (registry `lifecycle: retired` + repo deletion) is the documented cleanup.
 */

export const EXPERIMENT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

const DEFAULT_ORG = "oisin-ee";
const DEFAULT_TEMPLATE_SOURCE = "gh:oisin-ee/momokaya-template";
const DEFAULT_INFRA_REPO_URL = "https://github.com/oisin-ee/infra.git";
const FLEET_REGISTRY_DIR = "k8s/apps/platform-fleet/config";
const STAMPED_REGISTRY_DIR = "infra-registry/config";

export interface CreateExperimentOptions extends FactorySeams {
  readonly db?: boolean;
  readonly flavor?: "web" | "expo-web";
  readonly infraRepoUrl?: string;
  readonly name: string;
  readonly org?: string;
  readonly previews?: boolean;
  readonly templateRef?: string;
  readonly templateSource?: string;
  readonly workRoot?: string;
}

export interface CreateExperimentResult {
  readonly infraCommitSha: string;
  readonly registryPath: string;
  readonly repoUrl: string;
  readonly stampDir: string;
}

export const buildCopierCopyArgs = (options: {
  readonly db: boolean;
  readonly destination: string;
  readonly flavor: "web" | "expo-web";
  readonly name: string;
  readonly previews: boolean;
  readonly templateRef?: string;
  readonly templateSource: string;
}): string[] => [
  "copy",
  "--trust",
  "--defaults",
  ...(options.templateRef !== undefined && options.templateRef.length > 0
    ? ["--vcs-ref", options.templateRef]
    : []),
  "--data",
  `name=${options.name}`,
  "--data",
  `flavor=${options.flavor}`,
  "--data",
  `db=${options.db}`,
  "--data",
  `previews=${options.previews}`,
  options.templateSource,
  options.destination,
];

export const committerConfigArgs = (): string[] => [
  "-c",
  `user.name=${DEFAULT_RUNNER_COMMAND_GIT_COMMITTER.name}`,
  "-c",
  `user.email=${DEFAULT_RUNNER_COMMAND_GIT_COMMITTER.email}`,
];

const assertRepoAbsent = async (input: {
  readonly exec: NonNullable<FactorySeams["exec"]>;
  readonly name: string;
  readonly org: string;
}): Promise<void> => {
  const slug = `${input.org}/${input.name}`;
  const exists = await input
    .exec("gh", ["repo", "view", slug, "--json", "name"])
    .then(() => true)
    .catch(() => false);
  if (exists) {
    throw new Error(
      `create-experiment: repo ${slug} already exists — pick another name or retire the old experiment first`
    );
  }
};

export const runCreateExperiment = async (
  options: CreateExperimentOptions
): Promise<CreateExperimentResult> => {
  const { exec, git, log } = resolveFactorySeams(options);
  const { name } = options;
  if (!EXPERIMENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `create-experiment: name must be kebab-case (got ${JSON.stringify(name)})`
    );
  }
  const org = options.org ?? DEFAULT_ORG;
  const flavor = options.flavor ?? "web";
  const db = options.db ?? true;
  const previews = options.previews ?? true;
  const templateSource = options.templateSource ?? DEFAULT_TEMPLATE_SOURCE;
  const infraRepoUrl = options.infraRepoUrl ?? DEFAULT_INFRA_REPO_URL;
  const workRoot =
    options.workRoot ?? mkdtempSync(join(tmpdir(), "create-experiment-"));
  const stampDir = resolve(workRoot, name);
  const repoUrl = `https://github.com/${org}/${name}`;

  log(
    `create-experiment: birthing ${org}/${name} (flavor=${flavor} db=${db} previews=${previews})`
  );

  await assertRepoAbsent({ exec, name, org });

  log(`create-experiment: stamping ${templateSource} -> ${stampDir}`);
  await exec(
    "copier",
    buildCopierCopyArgs({
      db,
      destination: stampDir,
      flavor,
      name,
      previews,
      ...(options.templateRef !== undefined && options.templateRef.length > 0
        ? { templateRef: options.templateRef }
        : {}),
      templateSource,
    }),
    // copier fetches the private template with its own git subprocess — give it
    // the mounted github.com credential (see git-credentials.ts).
    { env: githubGitCredentialEnv() }
  );

  const stampedRegistryEntry = join(
    stampDir,
    STAMPED_REGISTRY_DIR,
    `${name}.yaml`
  );
  if (!existsSync(stampedRegistryEntry)) {
    throw new Error(
      `create-experiment: stamp is missing the registry entry ${STAMPED_REGISTRY_DIR}/${name}.yaml — template contract changed?`
    );
  }

  log("create-experiment: committing the stamped tree");
  await git(stampDir, ["init", "--initial-branch=main"]);
  await git(stampDir, ["add", "--all"]);
  await git(stampDir, [
    ...committerConfigArgs(),
    "commit",
    "-m",
    `feat: initial stamp from ${templateSource}`,
  ]);

  log(`create-experiment: creating ${repoUrl} (private)`);
  await exec("gh", ["repo", "create", `${org}/${name}`, "--private"]);
  await git(stampDir, ["remote", "add", "origin", `${repoUrl}.git`]);
  await git(stampDir, ["push", "-u", "origin", "main"]);

  log(`create-experiment: registering ${name} in the fleet registry`);
  const infraDir = resolve(workRoot, "infra");
  await git(workRoot, [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    infraRepoUrl,
    infraDir,
  ]);
  const registryPath = `${FLEET_REGISTRY_DIR}/${name}.yaml`;
  await mkdir(join(infraDir, FLEET_REGISTRY_DIR), { recursive: true });
  await copyFile(stampedRegistryEntry, join(infraDir, registryPath));
  await git(infraDir, ["add", "--", registryPath]);
  await git(infraDir, [
    ...committerConfigArgs(),
    "commit",
    "-m",
    `feat(fleet): register experiment ${name} (create-experiment lane)`,
  ]);
  await git(infraDir, ["push", "origin", "HEAD:main"]);
  const infraCommitSha = (await git(infraDir, ["rev-parse", "HEAD"])).trim();

  log(
    `create-experiment: done — repo=${repoUrl} registry=${registryPath} infraCommit=${infraCommitSha}`
  );
  return { infraCommitSha, registryPath, repoUrl, stampDir };
};
