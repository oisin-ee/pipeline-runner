import { execa } from "execa";
import { installCommands } from "./install-commands";

export type PipelineSkillInstaller = (cwd: string) => Promise<void>;

const DEFAULT_SKILL_INSTALL_SOURCE = "oisincoveney/skills";
const DEFAULT_SKILL_INSTALL_ARGS = [
  "--agent",
  "opencode",
  "--agent",
  "codex",
  "--agent",
  "claude-code",
  "--skill",
  "*",
  "--yes",
  "--copy",
];

export interface PipelineInitOptions {
  cwd?: string;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
}

async function installDefaultSkills(cwd: string): Promise<void> {
  try {
    await execa(
      "npx",
      [
        "--yes",
        "skills",
        "add",
        DEFAULT_SKILL_INSTALL_SOURCE,
        ...DEFAULT_SKILL_INSTALL_ARGS,
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
  const skillInstaller = options.skillInstaller ?? installDefaultSkills;
  await skillInstaller(cwd);
  const result = await installCommands({ cwd, force: true, host: "all" });
  return {
    files: result.items.map((item) => item.path),
  };
}

export function formatPipelineInitResult(result: PipelineInitResult): string {
  return [
    "Initialized package-owned pipeline support:",
    "installed default skills",
    ...result.files.map((path) => `generated ${path}`),
    "no repo-local pipeline config files were created",
  ].join("\n");
}
