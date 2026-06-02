import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const LINE_RE = /\r?\n/;
const LEADING_SLASHES_RE = /^\/+/;
const TRAILING_SLASHES_RE = /\/+$/;
const IMAGE_JOB_RE = /image|docker|container|ghcr/i;
const DOCKERFILE_BASE_IMAGE_RE = /FROM\s+(?:oven\/bun|node):/i;
const DOCKERFILE_PACKAGE_COPY_RE = /COPY\s+(?:package\.json|bun\.lock)/i;
const BUN_INSTALL_RE = /bun install --frozen-lockfile/i;
const BUILD_COMMAND_RE = /bun run build(?::cli)?/i;
const DIST_RE = /\bdist\b/;
const GIT_RE = /\bgit\b/i;
const RUNNER_JOB_ENTRYPOINT_RE =
  /\b(?:CMD|ENTRYPOINT)\b.*(?:(?:oisin-pipeline|pipe).*runner-job|node.*dist\/index\.js.*runner-job)/i;
const PIPELINE_CONSOLE_RE = /pipeline-console|apps\/console/i;
const DOCKER_BUILD_RE = /\bdocker\s+build\b/;
const DOCKER_RUN_RE = /\bdocker\s+run\b/;
const RUNNER_JOB_RE = /runner-job/;
const SEMANTIC_RELEASE_RE = /semantic-release/;
const IMAGE_JOB_FORBIDDEN_RELEASE_RE = /semantic-release|NPM_TOKEN/;
const PACKAGES_WRITE_RE = /packages:\s*write/i;
const DOCKER_LOGIN_ACTION_RE = /docker\/login-action/i;
const DOCKER_BUILD_PUSH_ACTION_RE = /docker\/build-push-action/i;
const GITHUB_SHA_EXPRESSION = ["$", "{{ github.sha }}"].join("");
const SHA_IMAGE_TAG = [
  "ghcr.io/oisin-ee/oisin-pipeline-runner:",
  GITHUB_SHA_EXPRESSION,
].join("");
const LATEST_IMAGE_TAG = "ghcr.io/oisin-ee/oisin-pipeline-runner:latest";

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function uncommentedLines(contents: string): string[] {
  return contents
    .split(LINE_RE)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function hasIgnorePattern(lines: string[], candidates: string[]): boolean {
  return candidates.some((candidate) =>
    lines.some((line) => {
      const normalizedLine = line
        .replace(LEADING_SLASHES_RE, "")
        .replace(TRAILING_SLASHES_RE, "");
      const normalizedCandidate = candidate
        .replace(LEADING_SLASHES_RE, "")
        .replace(TRAILING_SLASHES_RE, "");
      return (
        normalizedLine === normalizedCandidate ||
        normalizedLine === `${normalizedCandidate}/**` ||
        normalizedLine === `**/${normalizedCandidate}` ||
        normalizedLine === `**/${normalizedCandidate}/**`
      );
    })
  );
}

function workflowJobs(): Record<string, Record<string, unknown>> {
  const workflow = parseYaml(readProjectFile(".github/workflows/publish.yml"));
  return workflow.jobs as Record<string, Record<string, unknown>>;
}

function imagePublishingJobs(): [string, Record<string, unknown>][] {
  return Object.entries(workflowJobs()).filter(([id, job]) =>
    IMAGE_JOB_RE.test(`${id} ${String(job.name ?? "")} ${serialize(job)}`)
  );
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("runner container image packaging", () => {
  it("defines a Dockerfile for the runner image", () => {
    expect(existsSync(join(root, "Dockerfile"))).toBe(true);
  });

  it("builds the image from the TypeScript package and runtime dist output", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toMatch(DOCKERFILE_BASE_IMAGE_RE);
    expect(dockerfile).toMatch(DOCKERFILE_PACKAGE_COPY_RE);
    expect(dockerfile).toMatch(BUN_INSTALL_RE);
    expect(dockerfile).toMatch(BUILD_COMMAND_RE);
    expect(dockerfile).toMatch(DIST_RE);
    expect(dockerfile).toMatch(GIT_RE);
  });

  it("starts the Kubernetes runner Job entrypoint by default", () => {
    const dockerfile = readProjectFile("Dockerfile").replace(/\s+/g, " ");

    expect(dockerfile).toMatch(RUNNER_JOB_ENTRYPOINT_RE);
  });

  it("does not copy pipeline-console source into the runner image", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).not.toMatch(PIPELINE_CONSOLE_RE);
  });

  it("defines an image smoke-test package script", () => {
    const pkg = JSON.parse(readProjectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const imageSmokeTest = pkg.scripts?.["test:image"];

    expect(imageSmokeTest).toBeDefined();
    expect(imageSmokeTest).toMatch(DOCKER_BUILD_RE);
    expect(imageSmokeTest).toMatch(DOCKER_RUN_RE);
    expect(imageSmokeTest).toMatch(RUNNER_JOB_RE);
  });
});

describe("runner image Docker build context", () => {
  it("defines a .dockerignore for generated and local-only files", () => {
    expect(existsSync(join(root, ".dockerignore"))).toBe(true);
  });

  it("keeps backlog, run worktrees, dependencies, and test output out of the image context", () => {
    const lines = uncommentedLines(readProjectFile(".dockerignore"));

    expect(hasIgnorePattern(lines, ["backlog"])).toBe(true);
    expect(hasIgnorePattern(lines, [".pipeline/runs"])).toBe(true);
    expect(hasIgnorePattern(lines, ["node_modules"])).toBe(true);
    expect(hasIgnorePattern(lines, ["dist"])).toBe(true);
    expect(hasIgnorePattern(lines, ["coverage"])).toBe(true);
  });
});

describe("runner image publishing workflow", () => {
  it("publishes the runner image in a separate job from npm semantic-release", () => {
    const jobs = workflowJobs();
    const releaseJob = jobs.release;
    const imageJobs = imagePublishingJobs();

    expect(serialize(releaseJob)).toMatch(SEMANTIC_RELEASE_RE);
    expect(imageJobs.map(([id]) => id)).not.toContain("release");
    expect(imageJobs.length).toBeGreaterThan(0);
    expect(serialize(imageJobs)).not.toMatch(IMAGE_JOB_FORBIDDEN_RELEASE_RE);
  });

  it("pushes ghcr.io/oisin-ee/oisin-pipeline-runner with git SHA and latest tags", () => {
    const imagePublishing = serialize(imagePublishingJobs());
    const workflow = readProjectFile(".github/workflows/publish.yml");

    expect(workflow).toMatch(PACKAGES_WRITE_RE);
    expect(imagePublishing).toMatch(DOCKER_LOGIN_ACTION_RE);
    expect(imagePublishing).toMatch(DOCKER_BUILD_PUSH_ACTION_RE);
    expect(imagePublishing).toContain(SHA_IMAGE_TAG);
    expect(imagePublishing).toContain(LATEST_IMAGE_TAG);
  });
});
