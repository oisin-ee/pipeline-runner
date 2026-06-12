import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

const REPO_ROOT = process.cwd();
const DEVSPACE_PATH = join(REPO_ROOT, "devspace.yaml");
const DOCS_DIR = join(REPO_ROOT, "docs");
const SECRET_AUTH_CREDENTIAL_RE = /secret|auth|credential/i;
const CAVEAT_LIMITATION_WARNING_RE = /caveat|limitation|warning/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const flattenRecords = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.flatMap(flattenRecords);
  }

  if (!isRecord(value)) {
    return [];
  }

  return [value, ...Object.values(value).flatMap(flattenRecords)];
};

const getProfiles = (devspaceConfig: unknown): unknown =>
  isRecord(devspaceConfig) ? devspaceConfig.profiles : null;

const findRunnerProfile = (profiles: unknown): unknown => {
  if (profiles === null) {
    return null;
  }

  if (Array.isArray(profiles)) {
    return (
      profiles.find(
        (profile) => isRecord(profile) && profile.name === "runner"
      ) ?? null
    );
  }

  return isRecord(profiles) ? (profiles.runner ?? null) : null;
};

const readMarkdownDocs = (directory: string): string[] => {
  const entries = readdirSync(directory, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return readMarkdownDocs(path);
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      return [readFileSync(path, "utf8")];
    }

    return [];
  });
};

describe("DevSpace runner recipe", () => {
  it("defines a runner profile matching the Argo runner pod conventions", () => {
    const devspaceConfig = parse(readFileSync(DEVSPACE_PATH, "utf8"));
    const profiles = getProfiles(devspaceConfig);
    const runnerProfile = findRunnerProfile(profiles);

    expect(profiles).not.toBeNull();
    expect(runnerProfile).not.toBeNull();

    const runnerYaml = stringify(runnerProfile);
    const runnerRecords = flattenRecords(runnerProfile);
    const runnerEnv = runnerRecords.filter(
      (record) => record.name && record.value
    );

    expect(
      runnerYaml.includes("ghcr.io/oisin-ee/pipeline-runner:latest"),
      "runner profile should use the production runner image"
    ).toBe(true);
    expect(
      runnerYaml.includes("serviceAccountName: pipeline-runner"),
      "runner profile should use the production runner service account"
    ).toBe(true);
    expect(runnerEnv).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
          value: "0",
        }),
      ])
    );
    expect(runnerYaml).toContain("/root/.local/share/opencode/auth.json");
    expect(runnerYaml).toContain("/etc/pipeline/git-credentials");
    expect(runnerYaml).toContain("/root/.config/gh/hosts.yml");
    expect(runnerYaml).toContain("/workspace/oisin-pipeline");
    expect(runnerYaml).toContain("ghcr-pull-secret");
    expect(runnerYaml).toContain("opencode-auth-1");
    expect(runnerYaml).toContain("oisin-bot-git-credentials");
    expect(runnerYaml).toContain("oisin-bot-github-auth");
  });

  it("documents how to start and use the interactive runner pod", () => {
    expect(statSync(DOCS_DIR).isDirectory()).toBe(true);

    const docs = readMarkdownDocs(DOCS_DIR).join("\n---\n");

    expect(
      docs.includes("devspace dev --profile runner"),
      "runner docs should show how to start the DevSpace runner profile"
    ).toBe(true);
    expect(
      docs.includes("moka run --entrypoint quick"),
      "runner docs should show how to run the quick entrypoint inside the pod"
    ).toBe(true);
    expect(
      SECRET_AUTH_CREDENTIAL_RE.test(docs),
      "runner docs should mention required secrets/auth/credentials"
    ).toBe(true);
    expect(
      CAVEAT_LIMITATION_WARNING_RE.test(docs),
      "runner docs should include a caveat, limitation, or warning"
    ).toBe(true);
  });
});
