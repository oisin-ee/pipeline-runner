import { execa } from "execa";
import { installCommands } from "./install-commands";

export type PipelineSkillInstaller = (cwd: string) => Promise<void>;

/**
 * PIPE-83.12: where the default skill set is installed. "project" (default)
 * vendors a repo-local copy (the legacy `--copy` + skills-lock.json path);
 * "personal" installs once at user/global scope so every repo the user opens
 * inherits the skills with no per-repo copy and no project lockfile.
 */
export type PipelineSkillScope = "project" | "personal";

const DEFAULT_SKILL_INSTALL_SOURCE = "oisin-ee/skills";
const SKILL_INSTALL_AGENT_ARGS = [
  "--agent",
  "opencode",
  "--agent",
  "codex",
  "--agent",
  "claude-code",
  "--skill",
  "*",
  "--yes",
];

// fallow-ignore-next-line unused-export
export function skillInstallArgs(scope: PipelineSkillScope): string[] {
  // personal → user-global install (inherited, no per-repo copy/lockfile);
  // project → repo-local vendored copy (the legacy default).
  return scope === "personal"
    ? [...SKILL_INSTALL_AGENT_ARGS, "--global"]
    : [...SKILL_INSTALL_AGENT_ARGS, "--copy"];
}

export interface PipelineInitOptions {
  cwd?: string;
  scope?: PipelineSkillScope;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
  scope: PipelineSkillScope;
}

async function installDefaultSkills(
  cwd: string,
  scope: PipelineSkillScope
): Promise<void> {
  try {
    await execa(
      "npx",
      [
        "--yes",
        "skills",
        "add",
        DEFAULT_SKILL_INSTALL_SOURCE,
        ...skillInstallArgs(scope),
      ],
      { cwd, stdio: "inherit" }
    );
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Failed to install default skills from ${DEFAULT_SKILL_INSTALL_SOURCE}${cause}. ` +
        "If this is a private repository, authenticate GitHub access for npx skills add and rerun `moka init`."
    );
  }
}

export async function initPipelineProject(
  options: PipelineInitOptions = {}
): Promise<PipelineInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? "project";
  const skillInstaller =
    options.skillInstaller ?? ((target) => installDefaultSkills(target, scope));
  await skillInstaller(cwd);
  const result = await installCommands({ cwd, force: true, host: "all" });
  return {
    files: result.items.map((item) => item.path),
    scope,
  };
}

export function formatPipelineInitResult(result: PipelineInitResult): string {
  const skillLine =
    result.scope === "personal"
      ? "installed default skills at user/global scope (inherited by every repo, no per-repo copy)"
      : "installed default skills (repo-local copy)";
  return [
    "Initialized package-owned pipeline support:",
    skillLine,
    ...result.files.map((path) => `generated ${path}`),
    "no repo-local pipeline config files were created",
  ].join("\n");
}
