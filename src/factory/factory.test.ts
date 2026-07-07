import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildCopierCopyArgs,
  committerConfigArgs,
  runCreateExperiment,
} from "./create-experiment";
import type { FactoryExec, FactoryGit } from "./exec";
import { buildFactoryLaneJob, FACTORY_LANE_LABEL } from "./factory-lane";
import { githubGitCredentialEnv } from "./git-credentials";
import { isStampOf, parseCopierAnswers } from "./stamp-answers";
import { runTemplateUpdate, summarizeTemplateUpdate } from "./template-update";

const KEBAB_ERROR = /kebab-case/u;
const ALREADY_EXISTS_ERROR = /already exists/u;
const SIDE_EFFECT_CALLS = /^(copier copy|gh repo create|git push|git clone)/u;
const COPIER_COPY_CALL = /^copier copy/u;
const GH_REPO_CREATE_CALL = /^gh repo create oisin-ee\/scratch-app --private/u;
const APP_PUSH_CALL = /^git push -u origin main/u;
const GIT_CLONE_CALL = /^git clone/u;
const INFRA_PUSH_CALL = /^git push origin HEAD:main/u;
const REPO_DIR_PREFIX = /^update-/u;
const STORE_FILE_RE = /^store --file=(.+)$/u;

const MOMOKAYA_ANSWERS = [
  "_commit: v1.0.2",
  "_src_path: gh:oisin-ee/momokaya-template",
  "name: scratch-app",
].join("\n");

const OTHER_TEMPLATE_ANSWERS = [
  "_commit: HEAD",
  "_src_path: /tmp/bunx-1000-@oisincoveney/dev@latest/node_modules/@oisincoveney/dev/templates/copier",
].join("\n");

class FactoryTestError extends Schema.TaggedErrorClass<FactoryTestError>()(
  "FactoryTestError",
  { cause: Schema.Unknown }
) {}

const testPromise = <A>(
  evaluate: () => PromiseLike<A>
): Effect.Effect<A, FactoryTestError> =>
  Effect.tryPromise({
    catch: (cause) => new FactoryTestError({ cause }),
    try: async () => await evaluate(),
  });

const successfulExec: FactoryExec = async () =>
  await Promise.resolve({ stdout: "" });

const templateUpdateExec: FactoryExec = async (command, args) => {
  if (command === "copier") {
    return await Promise.resolve({ stdout: "" });
  }
  if (command === "gh" && args[0] === "pr") {
    return await Promise.resolve({
      stdout: "https://github.com/oisin-ee/stamped/pull/1\n",
    });
  }
  return await Promise.reject(new Error(`unexpected exec ${command}`));
};

const templateUpdateDirtyGit: FactoryGit = async (_cwd, args) => {
  if (args[0] === "clone") {
    const dir = String(args.at(-1));
    mkdirSync(dir, { recursive: true });
    const repo = basename(dir).replace(REPO_DIR_PREFIX, "");
    if (repo === "stamped") {
      writeFileSync(join(dir, ".copier-answers.yml"), MOMOKAYA_ANSWERS);
    }
    if (repo === "other") {
      writeFileSync(join(dir, ".copier-answers.yml"), OTHER_TEMPLATE_ANSWERS);
    }
    return await Promise.resolve("");
  }
  if (args[0] === "status") {
    return await Promise.resolve(" M mise.toml\n");
  }
  return await Promise.resolve("");
};

const templateUpdateCleanGit: FactoryGit = async (_cwd, args) => {
  if (args[0] === "clone") {
    const dir = String(args.at(-1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".copier-answers.yml"), MOMOKAYA_ANSWERS);
  }
  return await Promise.resolve("");
};

const existingRepoExec: FactoryExec = async (command, args) =>
  command === "gh" && args[1] === "view"
    ? await Promise.resolve({ stdout: "{}" })
    : await Promise.reject(new Error("unexpected exec"));

describe("stamp-answers", () => {
  it("parses the copier receipt fields", () => {
    const receipt = parseCopierAnswers(MOMOKAYA_ANSWERS);
    expect(receipt.commit).toBe("v1.0.2");
    expect(receipt.srcPath).toBe("gh:oisin-ee/momokaya-template");
  });

  it("accepts only momokaya-template stamps", () => {
    expect(
      isStampOf(parseCopierAnswers(MOMOKAYA_ANSWERS), "momokaya-template")
    ).toBe(true);
    expect(
      isStampOf(parseCopierAnswers(OTHER_TEMPLATE_ANSWERS), "momokaya-template")
    ).toBe(false);
    expect(isStampOf({}, "momokaya-template")).toBe(false);
  });
});

describe("buildCopierCopyArgs", () => {
  it("builds a headless trusted stamp invocation", () => {
    expect(
      buildCopierCopyArgs({
        db: true,
        destination: "/work/scratch-app",
        flavor: "web",
        name: "scratch-app",
        previews: false,
        templateSource: "gh:oisin-ee/momokaya-template",
      })
    ).toEqual([
      "copy",
      "--trust",
      "--defaults",
      "--data",
      "name=scratch-app",
      "--data",
      "flavor=web",
      "--data",
      "db=true",
      "--data",
      "previews=false",
      "gh:oisin-ee/momokaya-template",
      "/work/scratch-app",
    ]);
  });

  it("pins --vcs-ref when a template ref is given", () => {
    const args = buildCopierCopyArgs({
      db: false,
      destination: "/d",
      flavor: "expo-web",
      name: "x",
      previews: true,
      templateRef: "v1.0.2",
      templateSource: "gh:oisin-ee/momokaya-template",
    });
    expect(args.slice(3, 5)).toEqual(["--vcs-ref", "v1.0.2"]);
  });
});

describe("runTemplateUpdate", () => {
  it.effect("filters non-momokaya stamps and aggregates per-repo results", () =>
    Effect.gen(function* effectBody() {
      const workRoot = mkdtempSync(join(tmpdir(), "factory-update-"));

      const { results } = yield* testPromise(
        async () =>
          await runTemplateUpdate({
            exec: templateUpdateExec,
            git: templateUpdateDirtyGit,
            log: () => {},
            repos: ["stamped", "other", "bare"],
            workRoot,
          })
      );

      expect(results).toEqual([
        {
          prUrl: "https://github.com/oisin-ee/stamped/pull/1",
          repo: "stamped",
          status: "pr-opened",
          version: "v1.0.2",
        },
        {
          message:
            "stamped from /tmp/bunx-1000-@oisincoveney/dev@latest/node_modules/@oisincoveney/dev/templates/copier, not momokaya-template",
          repo: "other",
          status: "not-stamped",
        },
        { repo: "bare", status: "not-stamped" },
      ]);
      expect(summarizeTemplateUpdate(results)).toEqual({
        failed: 0,
        opened: 1,
      });
    })
  );

  it.effect("reports a clean tree as up-to-date", () =>
    Effect.gen(function* effectBody() {
      const workRoot = mkdtempSync(join(tmpdir(), "factory-clean-"));
      const { results } = yield* testPromise(
        async () =>
          await runTemplateUpdate({
            exec: successfulExec,
            git: templateUpdateCleanGit,
            log: () => {},
            repos: ["stamped"],
            workRoot,
          })
      );
      expect(results).toEqual([
        { repo: "stamped", status: "up-to-date", version: "v1.0.2" },
      ]);
    })
  );
});

describe("buildFactoryLaneJob", () => {
  it("builds a runner-image Job that overrides only the container args", () => {
    const job = buildFactoryLaneJob({
      argv: ["create-experiment", "--name", "scratch-app"],
      gitCredentialsSecretName: "oisin-bot-git-credentials",
      githubAuthSecretName: "oisin-bot-github-auth",
      image: "ghcr.io/oisin-ee/pipeline-runner:abc",
      imagePullSecretName: "ghcr-pull-secret",
      namespace: "momokaya-pipeline",
      serviceAccountName: "pipeline-runner",
    });

    expect(job.metadata.labels[FACTORY_LANE_LABEL]).toBe("create-experiment");
    const podSpec = job.spec.template.spec;
    const [container] = podSpec.containers;
    expect(container.args).toEqual([
      "create-experiment",
      "--name",
      "scratch-app",
    ]);
    expect("command" in container).toBe(false);
    expect(podSpec.restartPolicy).toBe("Never");
    expect(job.spec.backoffLimit).toBe(0);
    expect(podSpec.volumes.map((volume) => volume.name)).toEqual([
      "runner-git-credentials",
      "github-auth",
    ]);
    expect(container.volumeMounts).toEqual([
      {
        mountPath: "/etc/pipeline/git-credentials",
        name: "runner-git-credentials",
        readOnly: true,
      },
      {
        mountPath: "/root/.config/gh/hosts.yml",
        name: "github-auth",
        readOnly: true,
        subPath: "hosts.yml",
      },
    ]);
  });

  it("requires at least one argv element", () => {
    expect(() =>
      buildFactoryLaneJob({
        argv: [],
        gitCredentialsSecretName: "a",
        githubAuthSecretName: "b",
        image: "img",
        namespace: "ns",
      })
    ).toThrow();
  });
});

describe("committerConfigArgs", () => {
  it("pins the oisin-bot committer identity", () => {
    expect(committerConfigArgs()).toEqual([
      "-c",
      "user.name=oisin-bot",
      "-c",
      "user.email=git@oisin.ee",
    ]);
  });
});

describe("githubGitCredentialEnv", () => {
  it("returns empty env when no mounted credentials exist", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "factory-nocred-"));
    expect(githubGitCredentialEnv(emptyDir)).toEqual({});
  });

  it("builds a credential.helper store env from mounted username/password", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-cred-"));
    writeFileSync(join(dir, "username"), "oisin-bot\n");
    writeFileSync(join(dir, "password"), "ghp_secrettoken\n");

    const env = githubGitCredentialEnv(dir);

    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    const storeMatch = STORE_FILE_RE.exec(env.GIT_CONFIG_VALUE_0 ?? "");
    expect(storeMatch).not.toBeNull();
    if (storeMatch === null) {
      throw new Error("Expected credential.helper store file path");
    }
    const [, storePath] = storeMatch;
    // The token lands only in the 0600 store file, never in a URL/argv.
    expect(readFileSync(storePath, "utf-8")).toBe(
      "https://oisin-bot:ghp_secrettoken@github.com\n"
    );
  });
});

const failingExec: FactoryExec = () => {
  throw new Error("exec must not run");
};
const failingGit: FactoryGit = () => {
  throw new Error("git must not run");
};

describe("runCreateExperiment", () => {
  it.effect("rejects a non-kebab-case name before any side effect", () =>
    testPromise(async () => {
      await expect(
        runCreateExperiment({
          exec: failingExec,
          git: failingGit,
          name: "Bad_Name",
        })
      ).rejects.toThrow(KEBAB_ERROR);
    })
  );

  it.effect(
    "runs stamp -> repo create -> push -> registry commit in order",
    () =>
      Effect.gen(function* effectBody() {
        const workRoot = mkdtempSync(join(tmpdir(), "factory-test-"));
        const calls: string[] = [];
        const exec: FactoryExec = async (command, args) => {
          calls.push([command, ...args].join(" "));
          if (command === "gh" && args[0] === "repo" && args[1] === "view") {
            return await Promise.reject(new Error("not found"));
          }
          if (command === "copier") {
            const registryDir = join(
              workRoot,
              "scratch-app",
              "infra-registry",
              "config"
            );
            mkdirSync(registryDir, { recursive: true });
            writeFileSync(
              join(registryDir, "scratch-app.yaml"),
              "repo: scratch-app\n"
            );
          }
          return await Promise.resolve({ stdout: "" });
        };
        const git: FactoryGit = async (_cwd, args) => {
          calls.push(["git", ...args].join(" "));
          if (args[0] === "clone") {
            mkdirSync(join(String(args.at(-1)), "k8s"), { recursive: true });
          }
          return await Promise.resolve(
            args[0] === "rev-parse" ? "abc123\n" : ""
          );
        };

        const result = yield* testPromise(
          async () =>
            await runCreateExperiment({
              exec,
              git,
              log: () => {},
              name: "scratch-app",
              workRoot,
            })
        );

        expect(result.repoUrl).toBe("https://github.com/oisin-ee/scratch-app");
        expect(result.registryPath).toBe(
          "k8s/apps/platform-fleet/config/scratch-app.yaml"
        );
        expect(result.infraCommitSha).toBe("abc123");
        const sequence = calls.filter((call) => SIDE_EFFECT_CALLS.test(call));
        expect(sequence[0]).toMatch(COPIER_COPY_CALL);
        expect(sequence[1]).toMatch(GH_REPO_CREATE_CALL);
        expect(sequence[2]).toMatch(APP_PUSH_CALL);
        expect(sequence[3]).toMatch(GIT_CLONE_CALL);
        expect(sequence[4]).toMatch(INFRA_PUSH_CALL);
      })
  );

  it.effect("refuses to overwrite an existing repo", () =>
    testPromise(async () => {
      await expect(
        runCreateExperiment({
          exec: existingRepoExec,
          git: failingGit,
          log: () => {},
          name: "taken",
        })
      ).rejects.toThrow(ALREADY_EXISTS_ERROR);
    })
  );
});
