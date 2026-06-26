import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = process.cwd();
const OKTETO_PATH = join(REPO_ROOT, "okteto.yml");
const RUNNER_MANIFEST_PATH = join(
  REPO_ROOT,
  "k8s",
  "runner-dev",
  "deployment.yaml"
);
const DOCS_DIR = join(REPO_ROOT, "docs");
const SECRET_AUTH_CREDENTIAL_RE = /secret|auth|credential/i;
const CAVEAT_LIMITATION_WARNING_RE = /caveat|limitation|warning/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

describe("Okteto runner recipe", () => {
  it("defines a single `runner` dev block with no Platform-only deploy/destroy", () => {
    const oktetoConfig = parse(readFileSync(OKTETO_PATH, "utf8"));

    expect(isRecord(oktetoConfig)).toBe(true);
    if (!isRecord(oktetoConfig)) {
      return;
    }

    // OSS okteto rejects top-level deploy:/destroy: on `okteto up`; the runner
    // pod is stood up by the mise dev task (kubectl apply) instead.
    expect(oktetoConfig.deploy).toBeUndefined();
    expect(oktetoConfig.destroy).toBeUndefined();

    const dev = oktetoConfig.dev;
    expect(isRecord(dev)).toBe(true);
    if (!isRecord(dev)) {
      return;
    }

    expect(Object.keys(dev)).toEqual(["runner"]);

    const runner = dev.runner;
    expect(isRecord(runner)).toBe(true);
    if (!isRecord(runner)) {
      return;
    }

    expect(runner.selector).toMatchObject({
      "app.kubernetes.io/name": "pipeline-runner",
    });
    expect(runner.container).toBe("runner");
    expect(runner.image).toBe("ghcr.io/oisin-ee/pipeline-runner:latest");
    expect(runner.command).toBe("bash");
    expect(runner.workdir).toBe("/workspace/oisin-pipeline");
    expect(runner.sync).toEqual([".:/workspace/oisin-pipeline"]);
    expect(runner.environment).toMatchObject({
      CODEX_AUTH_PER_PROJECT_ACCOUNTS: "0",
    });
  });

  it("ships a runner Deployment manifest matching the Argo runner pod shape", () => {
    // Parity target: buildRunnerArgoWorkflowManifest in src/argo-workflow.ts —
    // same image / service account / env / secret mounts ("dev pod == prod
    // runner pod", PIPE-62 intent).
    const manifestYaml = readFileSync(RUNNER_MANIFEST_PATH, "utf8");
    const manifest = parse(manifestYaml);

    expect(isRecord(manifest)).toBe(true);
    expect((manifest as Record<string, unknown>).kind).toBe("Deployment");

    const podSpec = (manifest as { spec?: { template?: { spec?: unknown } } })
      .spec?.template?.spec;
    expect(isRecord(podSpec)).toBe(true);
    if (!isRecord(podSpec)) {
      return;
    }

    expect(podSpec.serviceAccountName).toBe("pipeline-runner");
    expect(podSpec.imagePullSecrets).toEqual([{ name: "ghcr-pull-secret" }]);

    const containers = podSpec.containers as
      | Record<string, unknown>[]
      | undefined;
    const runnerContainer = containers?.find((c) => c.name === "runner");
    expect(runnerContainer).toBeDefined();
    expect(runnerContainer?.image).toBe(
      "ghcr.io/oisin-ee/pipeline-runner:latest"
    );
    expect(runnerContainer?.workingDir).toBe("/workspace/oisin-pipeline");
    expect(runnerContainer?.env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
          value: "0",
        }),
      ])
    );

    // Runner secrets + their auth/env and mount paths.
    expect(manifestYaml).toContain("broker-api-key");
    expect(manifestYaml).toContain("BROKER_API_KEY");
    expect(manifestYaml).toContain("oisin-bot-git-credentials");
    expect(manifestYaml).toContain("oisin-bot-github-auth");
    expect(manifestYaml).toContain("ghcr-pull-secret");
    expect(manifestYaml).not.toContain("opencode-auth-1");
    expect(manifestYaml).not.toContain("/root/.local/share/opencode/auth.json");
    expect(manifestYaml).toContain("/etc/pipeline/git-credentials");
    expect(manifestYaml).toContain("/root/.config/gh/hosts.yml");
    expect(manifestYaml).toContain("/workspace/oisin-pipeline");
  });

  it("documents how to start and use the okteto runner pod", () => {
    expect(statSync(DOCS_DIR).isDirectory()).toBe(true);

    const docs = readMarkdownDocs(DOCS_DIR).join("\n---\n");

    expect(
      docs.includes("mise run dev"),
      "runner docs should show how to start the okteto runner inner loop"
    ).toBe(true);
    expect(
      docs.includes("okteto up runner"),
      "runner docs should reference the okteto up runner inner loop"
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
