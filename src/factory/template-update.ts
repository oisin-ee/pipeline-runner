import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

import { parseWithSchema, requiredString, struct } from "../schema-boundary";
import { committerConfigArgs } from "./create-experiment";
import { resolveFactorySeams } from "./exec";
import type { FactorySeams } from "./exec";
import { githubGitCredentialEnv } from "./git-credentials";
import { isStampOf, parseCopierAnswers } from "./stamp-answers";

/**
 * template-update lane (INFRA-087.12): when momokaya-template ships a new tag,
 * fan `copier update` PRs out across every repo stamped from it — one PR per
 * repo, never a direct push to an app repo's default branch.
 *
 * Discovery = fleet registry entries (the infra repo's
 * `k8s/apps/platform-fleet/config/*.yaml` → `repo:`) probed for a
 * `.copier-answers.yml` whose `_src_path` matches the template (the marker
 * alone is ambiguous across the org's copier templates — see
 * stamp-answers.ts).
 */

const DEFAULT_ORG = "oisin-ee";
const DEFAULT_TEMPLATE_MATCH = "momokaya-template";
const DEFAULT_INFRA_REPO_URL = "https://github.com/oisin-ee/infra.git";
const FLEET_REGISTRY_DIR = "k8s/apps/platform-fleet/config";
const ANSWERS_FILE = ".copier-answers.yml";

const registryEntryRepo = Schema.StructWithRest(struct({ repo: requiredString }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);

const isNonEmptyString = (value?: string): value is string => value !== undefined && value.length > 0;

export interface TemplateUpdateOptions extends FactorySeams {
  readonly infraRepoUrl?: string;
  readonly org?: string;
  /** Explicit repo list; skips fleet-registry discovery when provided. */
  readonly repos?: readonly string[];
  readonly templateMatch?: string;
  readonly templateRef?: string;
  readonly workRoot?: string;
}

export type TemplateUpdateRepoStatus = "error" | "not-stamped" | "pr-opened" | "up-to-date";

export interface TemplateUpdateRepoResult {
  readonly message?: string;
  readonly prUrl?: string;
  readonly repo: string;
  readonly status: TemplateUpdateRepoStatus;
  readonly version?: string;
}

export interface TemplateUpdateResult {
  readonly results: readonly TemplateUpdateRepoResult[];
}

export const summarizeTemplateUpdate = (
  results: readonly TemplateUpdateRepoResult[],
): { readonly failed: number; readonly opened: number } => ({
  failed: results.filter((entry) => entry.status === "error").length,
  opened: results.filter((entry) => entry.status === "pr-opened").length,
});

const discoverRegistryRepos = async (input: {
  readonly git: NonNullable<FactorySeams["git"]>;
  readonly infraRepoUrl: string;
  readonly workRoot: string;
}): Promise<string[]> => {
  const infraDir = resolve(input.workRoot, "infra-discovery");
  await input.git(input.workRoot, ["clone", "--depth", "1", "--single-branch", input.infraRepoUrl, infraDir]);
  const registryDir = join(infraDir, FLEET_REGISTRY_DIR);
  const repos = readdirSync(registryDir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => {
      const entry = parseWithSchema(registryEntryRepo, parseYaml(readFileSync(join(registryDir, file), "utf-8")), {
        onExcessProperty: "preserve",
      });
      return entry.repo;
    });
  return [...new Set(repos)].toSorted((left, right) => left.localeCompare(right));
};

const listRejectFiles = (cloneDir: string, porcelainStatus: string): string[] =>
  porcelainStatus
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((file) => file.endsWith(".rej") && existsSync(join(cloneDir, file)))
    .map((file) => basename(file));

const templateRefArgs = (templateRef?: string): string[] =>
  isNonEmptyString(templateRef) ? ["--vcs-ref", templateRef] : [];

const updateRepo = async (input: {
  readonly org: string;
  readonly repo: string;
  readonly seams: ReturnType<typeof resolveFactorySeams>;
  readonly templateMatch: string;
  readonly templateRef?: string;
  readonly workRoot: string;
}): Promise<TemplateUpdateRepoResult> => {
  const { exec, git } = input.seams;
  const { repo } = input;
  try {
    const cloneDir = resolve(input.workRoot, `update-${repo}`);
    await git(input.workRoot, ["clone", `https://github.com/${input.org}/${repo}.git`, cloneDir]);

    const answersPath = join(cloneDir, ANSWERS_FILE);
    if (!existsSync(answersPath)) {
      return { repo, status: "not-stamped" };
    }
    const receipt = parseCopierAnswers(readFileSync(answersPath, "utf-8"));
    if (!isStampOf(receipt, input.templateMatch)) {
      return {
        message: `stamped from ${receipt.srcPath ?? "unknown"}, not ${input.templateMatch}`,
        repo,
        status: "not-stamped",
      };
    }

    await git(cloneDir, ["checkout", "-b", "template-update/pending"]);
    await exec(
      "copier",
      ["update", "--trust", "--defaults", ...templateRefArgs(input.templateRef)],
      // copier re-fetches the private template with its own git subprocess.
      { cwd: cloneDir, env: githubGitCredentialEnv() },
    );

    const status = await git(cloneDir, ["status", "--porcelain"]);
    if (status.trim().length === 0) {
      return {
        repo,
        status: "up-to-date",
        ...(receipt.commit === undefined ? {} : { version: receipt.commit }),
      };
    }

    const updated = parseCopierAnswers(readFileSync(answersPath, "utf-8"));
    const version = updated.commit ?? "unknown";
    const branch = `chore/template-update-${version}`;
    const rejects = listRejectFiles(cloneDir, status);
    await git(cloneDir, ["branch", "-m", branch]);
    await git(cloneDir, ["add", "--all"]);
    await git(cloneDir, [...committerConfigArgs(), "commit", "-m", `chore: copier update to ${version}`]);
    await git(cloneDir, ["push", "-u", "origin", branch]);

    const prBody = [
      `Automated \`copier update\` to momokaya-template ${version} (template-update lane).`,
      ...(rejects.length > 0
        ? ["", "WARNING — conflict rejects need manual resolution:", ...rejects.map((file) => `- \`${file}\``)]
        : []),
    ].join("\n");
    const { stdout } = await exec(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        `${input.org}/${repo}`,
        "--head",
        branch,
        "--title",
        `chore: copier update to ${version}`,
        "--body",
        prBody,
      ],
      { cwd: cloneDir },
    );
    return { prUrl: stdout.trim(), repo, status: "pr-opened", version };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      repo,
      status: "error",
    };
  }
};

interface TemplateUpdateRunContext {
  readonly org: string;
  readonly seams: ReturnType<typeof resolveFactorySeams>;
  readonly templateMatch: string;
  readonly templateRef?: string;
  readonly workRoot: string;
}

const templateUpdateWorkRoot = (workRoot?: string): string =>
  workRoot ?? mkdtempSync(join(tmpdir(), "template-update-"));

const discoverTemplateUpdateRepos = async (
  options: TemplateUpdateOptions,
  context: TemplateUpdateRunContext,
): Promise<string[]> => {
  if (options.repos !== undefined && options.repos.length > 0) {
    return [...options.repos];
  }
  return await discoverRegistryRepos({
    git: context.seams.git,
    infraRepoUrl: options.infraRepoUrl ?? DEFAULT_INFRA_REPO_URL,
    workRoot: context.workRoot,
  });
};

const optionalTemplateRef = (templateRef?: string): { readonly templateRef?: string } =>
  isNonEmptyString(templateRef) ? { templateRef } : {};

const updateTemplateRepos = async (
  context: TemplateUpdateRunContext,
  repos: readonly string[],
): Promise<TemplateUpdateRepoResult[]> => {
  const results: TemplateUpdateRepoResult[] = [];
  for (const repo of repos) {
    results.push(
      await updateRepo({
        org: context.org,
        repo,
        seams: context.seams,
        ...optionalTemplateRef(context.templateRef),
        templateMatch: context.templateMatch,
        workRoot: context.workRoot,
      }),
    );
  }
  return results;
};

const templateUpdateResultLogLine = (entry: TemplateUpdateRepoResult): string => {
  const prUrl = isNonEmptyString(entry.prUrl) ? ` ${entry.prUrl}` : "";
  const message = isNonEmptyString(entry.message) ? ` (${entry.message})` : "";
  return `template-update: ${entry.repo} -> ${entry.status}${prUrl}${message}`;
};

const logTemplateUpdateResults = (
  log: ReturnType<typeof resolveFactorySeams>["log"],
  results: readonly TemplateUpdateRepoResult[],
): void => {
  for (const entry of results) {
    log(templateUpdateResultLogLine(entry));
  }
};

export const runTemplateUpdate = async (options: TemplateUpdateOptions): Promise<TemplateUpdateResult> => {
  const seams = resolveFactorySeams(options);
  const { log } = seams;
  const context: TemplateUpdateRunContext = {
    org: options.org ?? DEFAULT_ORG,
    seams,
    templateMatch: options.templateMatch ?? DEFAULT_TEMPLATE_MATCH,
    ...optionalTemplateRef(options.templateRef),
    workRoot: templateUpdateWorkRoot(options.workRoot),
  };

  const repos = await discoverTemplateUpdateRepos(options, context);
  log(`template-update: candidates [${repos.join(", ")}]`);

  const results = await updateTemplateRepos(context, repos);
  logTemplateUpdateResults(log, results);
  return { results };
};
