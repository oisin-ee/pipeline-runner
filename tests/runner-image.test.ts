import { execFileSync } from "node:child_process";
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
const CODEX_NPM_PACKAGE_RE = /@openai\/codex@\$\{CODEX_PACKAGE_VERSION\}/;
const OPENCODE_NPM_PACKAGE_RE = /opencode-ai@\$\{OPENCODE_PACKAGE_VERSION\}/;
const CLAUDE_NPM_PACKAGE_RE =
  /@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_PACKAGE_VERSION\}/;
const PNPM_NPM_PACKAGE_RE = /pnpm@\$\{PNPM_PACKAGE_VERSION\}/;
const PNPM_COMMAND_RE = /command -v pnpm/;
const BUN_NPM_PACKAGE_RE = /bun@\$\{BUN_PACKAGE_VERSION\}/;
const BUN_COMMAND_RE = /command -v bun/;
const TOOLHIVE_VERSION_ARG_RE = /ARG\s+TOOLHIVE_VERSION=0\.29\.1/;
const TOOLHIVE_SHA_ARG_RE =
  /ARG\s+TOOLHIVE_LINUX_AMD64_SHA256=a70f9b74493c7d3d8b62187e5b838e4333b07477810b83eb5086879b9fa37bc8/;
const TOOLHIVE_DOWNLOAD_RE =
  /https:\/\/github\.com\/stacklok\/toolhive\/releases\/download\/v\$\{TOOLHIVE_VERSION\}\/toolhive_\$\{TOOLHIVE_VERSION\}_linux_amd64\.tar\.gz/;
const TOOLHIVE_CHECKSUM_RE =
  /echo\s+"\$\{TOOLHIVE_LINUX_AMD64_SHA256\}\s+\/tmp\/toolhive\.tar\.gz"\s+\|\s+sha256sum\s+-c\s+-/;
const TOOLHIVE_INSTALL_RE =
  /tar\s+-xzf\s+\/tmp\/toolhive\.tar\.gz\s+-C\s+\/usr\/local\/bin\s+thv/;
const TOOLHIVE_COMMAND_RE = /command -v thv/;
const TOOLHIVE_VERSION_COMMAND_RE = /thv version/;
const HELM_IMAGE_STAGE_RE =
  /FROM\s+alpine\/helm:4\.2\.0@sha256:af08f75a3130d666a50b9fc150f40987ef20b885cf67659aabf4b83a5f2c5501\s+AS\s+helm/;
const HELM_COPY_RE =
  /COPY\s+--from=helm\s+\/usr\/bin\/helm\s+\/usr\/local\/bin\/helm/;
const HELM_COMMAND_RE = /command -v helm/;
const UV_IMAGE_STAGE_RE =
  /FROM\s+ghcr\.io\/astral-sh\/uv:0\.9\.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2\s+AS\s+uv/;
const UV_COPY_RE = /COPY\s+--from=uv\s+\/uv\s+\/uvx\s+\/usr\/local\/bin\//;
const UVX_COMMAND_RE = /command -v uvx/;
const NPM_GLOBAL_INSTALL_RE = /npm\s+install\s+-g/i;
const LOCAL_PIPELINE_COPY_RE = /COPY\s+(?:package\.json|src|defaults)\b/i;
const PACKAGE_SKILLS_COPY_RE = /COPY\s+\.agents\/skills\s+\.\/\.agents\/skills/;
const PIPELINE_SKILLS_COPY_RE =
  /COPY\s+\.pipeline\/skills\s+\.\/\.pipeline\/skills/;
const LOCAL_PIPELINE_INSTALL_RE =
  /npm\s+install\s+-g[\s\S]*\/tmp\/pipeline-package\.tgz/i;
const NPM_BUILD_RE = /npm\s+run\s+build/i;
const BUN_BUILD_RE = /bun\s+(?:install|run\s+build(?::cli)?)/i;
const GIT_RE = /\bgit\b/i;
const GITHUB_CLI_RE = /\bgh\b/i;
const RUNNER_JOB_ENTRYPOINT_RE =
  /ENTRYPOINT\s+\["oisin-pipeline"\][\s\S]*CMD\s+\["runner-job"\]/i;
const RUNNER_ENTRYPOINT_COPY_RE =
  /COPY\s+docker\/runner-entrypoint\.sh\s+\/usr\/local\/bin\/runner-entrypoint/i;
const RUNNER_NODE_ENV_PRODUCTION_RE = /ENV\s+NODE_ENV=production/;
const RUNNER_HOME_RE = /ENV\s+HOME=\/root/;
const RUNNER_CODEX_HOME_RE = /ENV\s+CODEX_HOME=\/root\/\.codex/;
const RUNNER_CODEX_AUTH_DIR_RE = /mkdir\s+-p[\s\S]*"\$CODEX_HOME"/;
const RUNNER_OPENCODE_AUTH_DIR_RE =
  /mkdir\s+-p[\s\S]*\/root\/\.local\/share\/opencode/;
const RUNNER_GITHUB_AUTH_DIR_RE = /mkdir\s+-p[\s\S]*\/root\/\.config\/gh/;
const AUTH_JSON_ENV_RE = /CODEX_AUTH_JSON|OPENCODE_AUTH_JSON|PI_AUTH_JSON/;
const PIPELINE_CONSOLE_RE = /pipeline-console|apps\/console/i;
const DOCKER_BUILD_RE = /\bdocker\s+build\b/;
const DOCKER_RUN_RE = /\bdocker\s+run\b/;
const RUNNER_JOB_RE = /runner-job/;
const SEMANTIC_RELEASE_RE = /semantic-release/;
const IMAGE_JOB_FORBIDDEN_RELEASE_RE = /semantic-release|NPM_TOKEN/;
const PACKAGES_WRITE_RE = /packages:\s*write/i;
const DOCKER_LOGIN_ACTION_RE = /docker\/login-action/i;
const DOCKER_BUILD_PUSH_ACTION_RE = /docker\/build-push-action/i;
const CONTRACT_VERSION_ARG_RE = /ARG\s+RUNNER_JOB_CONTRACT_VERSION=1/;
const CONTRACT_VERSION_LABEL_RE =
  /pipeline\.oisin\.dev\.runner-contract-version=\$\{RUNNER_JOB_CONTRACT_VERSION\}/;
const PACKAGE_VERSION_LABEL_RE =
  /pipeline\.oisin\.dev\.pipeline-package-version=\$\{PIPELINE_PACKAGE_VERSION\}/;
const GITHUB_SHA_EXPRESSION = ["$", "{{ github.sha }}"].join("");
const SHA_IMAGE_TAG = [
  "ghcr.io/oisin-ee/pipeline-runner:",
  GITHUB_SHA_EXPRESSION,
].join("");
const LATEST_IMAGE_TAG = "ghcr.io/oisin-ee/pipeline-runner:latest";
const REQUIRED_PACKED_ASSETS = [
  ".agents/skills/research/SKILL.md",
  ".agents/skills/verify/SKILL.md",
  ".pipeline/skills/schedule-graph-shaping/SKILL.md",
];

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

function packedPackageFiles(): string[] {
  const stdout = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const [pack] = JSON.parse(stdout) as Array<{
    files: Array<{ path: string }>;
  }>;
  return pack.files.map((file) => file.path);
}

describe("runner container image packaging", () => {
  it("defines a Dockerfile for the runner image", () => {
    expect(existsSync(join(root, "Dockerfile"))).toBe(true);
  });

  it("builds the local pipeline checkout and installs agent CLIs from npm", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toMatch(DOCKERFILE_BASE_IMAGE_RE);
    expect(dockerfile).toMatch(LOCAL_PIPELINE_COPY_RE);
    expect(dockerfile).toMatch(PACKAGE_SKILLS_COPY_RE);
    expect(dockerfile).toMatch(PIPELINE_SKILLS_COPY_RE);
    expect(dockerfile).toMatch(NPM_BUILD_RE);
    expect(dockerfile).toMatch(LOCAL_PIPELINE_INSTALL_RE);
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
    expect(dockerfile).toMatch(CODEX_NPM_PACKAGE_RE);
    expect(dockerfile).toMatch(OPENCODE_NPM_PACKAGE_RE);
    expect(dockerfile).toMatch(CLAUDE_NPM_PACKAGE_RE);
    expect(dockerfile).toMatch(GIT_RE);
    expect(dockerfile).toMatch(GITHUB_CLI_RE);
    expect(dockerfile).not.toMatch(BUN_BUILD_RE);
  });

  it("labels the image with package and runner payload contract versions", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toMatch(CONTRACT_VERSION_ARG_RE);
    expect(dockerfile).toMatch(CONTRACT_VERSION_LABEL_RE);
    expect(dockerfile).toMatch(PACKAGE_VERSION_LABEL_RE);
  });

  it("starts the Kubernetes runner Job entrypoint by default", () => {
    const dockerfile = readProjectFile("Dockerfile").replace(/\s+/g, " ");

    expect(dockerfile).toMatch(RUNNER_JOB_ENTRYPOINT_RE);
  });

  it("uses native agent auth file mounts instead of env materialization", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toMatch(RUNNER_HOME_RE);
    expect(dockerfile).toMatch(RUNNER_CODEX_HOME_RE);
    expect(dockerfile).toMatch(RUNNER_CODEX_AUTH_DIR_RE);
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
    expect(imageSmokeTest).toMatch(RUNNER_JOB_RE);
  });

  it("packs package-owned skill assets required by generated schedules", () => {
    expect(packedPackageFiles()).toEqual(
      expect.arrayContaining(REQUIRED_PACKED_ASSETS)
    );
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

  it("builds the runner image directly from the checked-out local package", () => {
    const imagePublishing = serialize(imagePublishingJobs());

    expect(imagePublishing).not.toContain("needs");
    expect(imagePublishing).not.toContain("PIPELINE_PACKAGE_VERSION=latest");
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
