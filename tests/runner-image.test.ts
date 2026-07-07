import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const LINE_RE = /\r?\n/u;
const LEADING_SLASHES_RE = /^\/+/u;
const TRAILING_SLASHES_RE = /\/+$/u;
const IMAGE_JOB_RE = /image|docker|container|ghcr/iu;
const DOCKERFILE_BASE_IMAGE_RE = /FROM\s+node:/iu;
const OPENCODE_NPM_PACKAGE_RE = /opencode-ai@\$\{OPENCODE_PACKAGE_VERSION\}/u;
const CLAUDE_NPM_PACKAGE_RE =
  /@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_PACKAGE_VERSION\}/u;
const PNPM_NPM_PACKAGE_RE = /pnpm@\$\{PNPM_PACKAGE_VERSION\}/u;
const PNPM_COMMAND_RE = /command -v pnpm/u;
const BUN_NPM_PACKAGE_RE = /bun@\$\{BUN_PACKAGE_VERSION\}/u;
const BUN_COMMAND_RE = /command -v bun/u;
const TOOLHIVE_VERSION_ARG_RE = /ARG\s+TOOLHIVE_VERSION=0\.29\.1/u;
const TOOLHIVE_SHA_ARG_RE =
  /ARG\s+TOOLHIVE_LINUX_AMD64_SHA256=a70f9b74493c7d3d8b62187e5b838e4333b07477810b83eb5086879b9fa37bc8/u;
const TOOLHIVE_DOWNLOAD_RE =
  /https:\/\/github\.com\/stacklok\/toolhive\/releases\/download\/v\$\{TOOLHIVE_VERSION\}\/toolhive_\$\{TOOLHIVE_VERSION\}_linux_amd64\.tar\.gz/u;
const TOOLHIVE_CHECKSUM_RE =
  /echo\s+"\$\{TOOLHIVE_LINUX_AMD64_SHA256\}\s+\/tmp\/toolhive\.tar\.gz"\s+\|\s+sha256sum\s+-c\s+-/u;
const TOOLHIVE_INSTALL_RE =
  /tar\s+-xzf\s+\/tmp\/toolhive\.tar\.gz\s+-C\s+\/usr\/local\/bin\s+thv/u;
const TOOLHIVE_COMMAND_RE = /command -v thv/u;
const TOOLHIVE_VERSION_COMMAND_RE = /thv version/u;
const HELM_IMAGE_STAGE_RE =
  /FROM\s+alpine\/helm:4\.2\.0@sha256:af08f75a3130d666a50b9fc150f40987ef20b885cf67659aabf4b83a5f2c5501\s+AS\s+helm/u;
const HELM_COPY_RE =
  /COPY\s+--from=helm\s+\/usr\/bin\/helm\s+\/usr\/local\/bin\/helm/u;
const HELM_COMMAND_RE = /command -v helm/u;
const UV_IMAGE_STAGE_RE =
  /FROM\s+ghcr\.io\/astral-sh\/uv:0\.9\.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2\s+AS\s+uv/u;
const UV_COPY_RE = /COPY\s+--from=uv\s+\/uv\s+\/uvx\s+\/usr\/local\/bin\//u;
const UVX_COMMAND_RE = /command -v uvx/u;
const NPM_GLOBAL_INSTALL_RE = /npm\s+install\s+-g/iu;
const PUBLISHED_PIPELINE_INSTALL_RE =
  /@oisincoveney\/pipeline@\$\{PIPELINE_PACKAGE_VERSION\}/u;
const LOCAL_PIPELINE_PACKAGE_RE =
  /npm\s+pack|pipeline-package\.tgz|\/tmp\/oisincoveney-pipeline|COPY\s+(?:package\.json|src|defaults|\.agents|\.pipeline)\b|npm\s+run\s+build/iu;
const BUN_BUILD_RE = /bun\s+(?:install|run\s+build(?::cli)?)/iu;
const GIT_RE = /\bgit\b/iu;
const GITHUB_CLI_RE = /\bgh\b/iu;
const RUNNER_COMMAND_ENTRYPOINT_RE =
  /ENTRYPOINT\s+\["moka"\][\s\S]*CMD\s+\["runner-command"\]/iu;
const RUNNER_ENTRYPOINT_COPY_RE =
  /COPY\s+docker\/runner-entrypoint\.sh\s+\/usr\/local\/bin\/runner-entrypoint/iu;
const RUNNER_NODE_ENV_PRODUCTION_RE = /ENV\s+NODE_ENV=production/u;
const RUNNER_HOME_RE = /ENV\s+HOME=\/root/u;
const RUNNER_OPENCODE_AUTH_DIR_RE =
  /mkdir\s+-p[\s\S]*\/root\/\.local\/share\/opencode/u;
const RUNNER_GITHUB_AUTH_DIR_RE = /mkdir\s+-p[\s\S]*\/root\/\.config\/gh/u;
const AUTH_JSON_ENV_RE = /OPENCODE_AUTH_JSON|PI_AUTH_JSON/u;
const PIPELINE_CONSOLE_RE = /pipeline-console|apps\/console/iu;
const DOCKER_BUILD_RE = /\bdocker\s+build\b/u;
const DOCKER_RUN_RE = /\bdocker\s+run\b/u;
const RUNNER_COMMAND_RE = /runner-command/u;
const SEMANTIC_RELEASE_RE = /semantic-release/u;
const PACKAGES_WRITE_RE = /packages:\s*write/iu;
const DOCKER_LOGIN_ACTION_RE = /docker\/login-action/iu;
const DOCKER_BUILD_PUSH_ACTION_RE = /docker\/build-push-action/iu;
const LOCAL_IMAGE_PACKAGE_RE = /npm pack|pipeline-package\.tgz/u;
const IMPERATIVE_PACKAGE_RESOLUTION_RE = /gitHead|node <<|for attempt/u;
const NPM_PACKAGE_VERSION_RESOLUTION_RE =
  /npm view @oisincoveney\/pipeline version/u;
const NPM_AUTH_TOKEN_RE = /NPM_TOKEN|NODE_AUTH_TOKEN/u;
const CONTRACT_VERSION_ARG_RE = /ARG\s+RUNNER_COMMAND_CONTRACT_VERSION=1/u;
const CONTRACT_VERSION_LABEL_RE =
  /pipeline\.oisin\.dev\.runner-contract-version=\$\{RUNNER_COMMAND_CONTRACT_VERSION\}/u;
const PACKAGE_VERSION_LABEL_RE =
  /pipeline\.oisin\.dev\.pipeline-package-version=\$\{PIPELINE_PACKAGE_VERSION\}/u;
const GITHUB_SHA_EXPRESSION = ["$", "{{ github.sha }}"].join("");
const SHA_IMAGE_TAG = [
  "ghcr.io/oisin-ee/pipeline-runner:",
  GITHUB_SHA_EXPRESSION,
].join("");
const LATEST_IMAGE_TAG = "ghcr.io/oisin-ee/pipeline-runner:latest";
const PIPELINE_PACKAGE_DEFAULT_RE = /ARG\s+PIPELINE_PACKAGE_VERSION=latest/u;
const PIPELINE_PACKAGE_BUILD_ARG_RE =
  /PIPELINE_PACKAGE_VERSION=\$\{\{ needs\.release\.outputs\.version \}\}/u;

const readProjectFile = (path: string): string =>
  readFileSync(join(root, path), "utf-8");

const uncommentedLines = (contents: string): string[] =>
  contents
    .split(LINE_RE)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

const hasIgnorePattern = (lines: string[], candidates: string[]): boolean =>
  candidates.some((candidate) =>
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

const workflowJobs = (): Record<string, Record<string, unknown>> => {
  const workflow = parseYaml(readProjectFile(".github/workflows/publish.yml"));
  return workflow.jobs as Record<string, Record<string, unknown>>;
};

const serialize = (value: unknown): string => JSON.stringify(value, null, 2);

const imagePublishingJobs = (): [string, Record<string, unknown>][] =>
  Object.entries(workflowJobs()).filter(([id, job]) =>
    IMAGE_JOB_RE.test(`${id} ${String(job.name ?? "")} ${serialize(job)}`)
  );

describe("runner container image packaging", () => {
  it("defines a Dockerfile for the runner image", () => {
    expect(existsSync(join(root, "Dockerfile"))).toBe(true);
  });

  it("installs the published pipeline package and agent CLIs from npm by default", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toMatch(DOCKERFILE_BASE_IMAGE_RE);
    expect(dockerfile).toMatch(PIPELINE_PACKAGE_DEFAULT_RE);
    expect(dockerfile).toMatch(PUBLISHED_PIPELINE_INSTALL_RE);
    expect(dockerfile).toMatch(NPM_GLOBAL_INSTALL_RE);
    expect(dockerfile).toMatch(PNPM_NPM_PACKAGE_RE);
    expect(dockerfile).toMatch(PNPM_COMMAND_RE);
    expect(dockerfile).toMatch(BUN_NPM_PACKAGE_RE);
    expect(dockerfile).toMatch(BUN_COMMAND_RE);
    expect(dockerfile).toMatch(TOOLHIVE_VERSION_ARG_RE);
    expect(dockerfile).toMatch(TOOLHIVE_SHA_ARG_RE);
    expect(dockerfile).toMatch(TOOLHIVE_DOWNLOAD_RE);
    expect(dockerfile).toMatch(TOOLHIVE_CHECKSUM_RE);
    expect(dockerfile).toMatch(TOOLHIVE_INSTALL_RE);
    expect(dockerfile).toMatch(TOOLHIVE_COMMAND_RE);
    expect(dockerfile).toMatch(TOOLHIVE_VERSION_COMMAND_RE);
    expect(dockerfile).toMatch(HELM_IMAGE_STAGE_RE);
    expect(dockerfile).toMatch(HELM_COPY_RE);
    expect(dockerfile).toMatch(HELM_COMMAND_RE);
    expect(dockerfile).toMatch(UV_IMAGE_STAGE_RE);
    expect(dockerfile).toMatch(UV_COPY_RE);
    expect(dockerfile).toMatch(UVX_COMMAND_RE);
    expect(dockerfile).toMatch(OPENCODE_NPM_PACKAGE_RE);
    expect(dockerfile).toMatch(CLAUDE_NPM_PACKAGE_RE);
    expect(dockerfile).toMatch(GIT_RE);
    expect(dockerfile).toMatch(GITHUB_CLI_RE);
    expect(dockerfile).not.toMatch(LOCAL_PIPELINE_PACKAGE_RE);
    expect(dockerfile).not.toMatch(BUN_BUILD_RE);
  });

  it("labels the image with package and runner payload contract versions", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toMatch(CONTRACT_VERSION_ARG_RE);
    expect(dockerfile).toMatch(CONTRACT_VERSION_LABEL_RE);
    expect(dockerfile).toMatch(PACKAGE_VERSION_LABEL_RE);
  });

  it("starts the generic runner command entrypoint by default", () => {
    const dockerfile = readProjectFile("Dockerfile").replaceAll(/\s+/gu, " ");

    expect(dockerfile).toMatch(RUNNER_COMMAND_ENTRYPOINT_RE);
  });

  it("uses native agent auth file mounts instead of env materialization", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toMatch(RUNNER_HOME_RE);
    expect(dockerfile).toMatch(RUNNER_OPENCODE_AUTH_DIR_RE);
    expect(dockerfile).toMatch(RUNNER_GITHUB_AUTH_DIR_RE);
    expect(dockerfile).not.toMatch(RUNNER_NODE_ENV_PRODUCTION_RE);
    expect(dockerfile).not.toMatch(RUNNER_ENTRYPOINT_COPY_RE);
    expect(dockerfile).not.toMatch(AUTH_JSON_ENV_RE);
    expect(existsSync(join(root, "docker/runner-entrypoint.sh"))).toBe(false);
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
    expect(imageSmokeTest).toMatch(RUNNER_COMMAND_RE);
  });

  it("publishes package-owned config without publishing install-managed skill assets", () => {
    const pkg = JSON.parse(readProjectFile("package.json")) as {
      files?: string[];
    };

    // Skills are installed by the shared agent harness into host dirs, so the
    // package ships neither the repo harness copy (.agents/skills) nor a
    // project-installed copy (.pipeline/skills); it ships the runtime config
    // defaults it owns.
    expect(pkg.files).toContain("defaults");
    expect(pkg.files).not.toContain(".agents/skills");
    expect(pkg.files).not.toContain(".pipeline/skills");
  });
});

describe("runner image npm release dependency", () => {
  it("builds the runner image with the release-output version, never querying the registry", () => {
    const jobs = workflowJobs();
    const imageJobs = imagePublishingJobs();
    const imagePublishing = serialize(imageJobs);

    expect(jobs["runner-image"]?.needs).toBe("release");
    // Version comes from the release job output (semantic-release's own version),
    // not a registry lookup that races npm's read-after-write propagation.
    expect(imagePublishing).toMatch(PIPELINE_PACKAGE_BUILD_ARG_RE);
    expect(imagePublishing).not.toMatch(NPM_PACKAGE_VERSION_RESOLUTION_RE);
    expect(imagePublishing).not.toMatch(LOCAL_IMAGE_PACKAGE_RE);
    expect(imagePublishing).not.toMatch(IMPERATIVE_PACKAGE_RESOLUTION_RE);
  });

  it("does not expose npm publish credentials to the image job", () => {
    const imagePublishing = serialize(imagePublishingJobs());

    expect(imagePublishing).not.toMatch(NPM_AUTH_TOKEN_RE);
  });
});

describe("runner image publishing workflow", () => {
  it("publishes the runner image in a separate job after npm semantic-release", () => {
    const jobs = workflowJobs();
    const releaseJob = jobs.release;
    const imageJobs = imagePublishingJobs();

    expect(serialize(releaseJob)).toMatch(SEMANTIC_RELEASE_RE);
    expect(imageJobs.map(([id]) => id)).not.toContain("release");
    expect(imageJobs.length).toBeGreaterThan(0);
    expect(jobs["runner-image"]?.needs).toBe("release");
  });

  it("pushes ghcr.io/oisin-ee/pipeline-runner with git SHA and latest tags", () => {
    const imagePublishing = serialize(imagePublishingJobs());
    const workflow = readProjectFile(".github/workflows/publish.yml");

    expect(workflow).toMatch(PACKAGES_WRITE_RE);
    expect(imagePublishing).toMatch(DOCKER_LOGIN_ACTION_RE);
    expect(imagePublishing).toMatch(DOCKER_BUILD_PUSH_ACTION_RE);
    expect(imagePublishing).toContain(SHA_IMAGE_TAG);
    expect(imagePublishing).toContain(LATEST_IMAGE_TAG);
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
