import { execa } from "execa";
import { installCommands } from "./install-commands";
import {
  DEFAULT_SKILL_INSTALLS,
  type PipelineSkillInstallSpec,
} from "./mcp/bootstrap";

export type PipelineSkillInstaller = (
  specs: PipelineSkillInstallSpec[],
  cwd: string
) => Promise<void>;

export interface PipelineInitOptions {
  cwd?: string;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
}

export async function installDefaultSkillsWithCli(
  specs: PipelineSkillInstallSpec[],
  cwd: string
): Promise<void> {
  for (const spec of specs) {
    await execa(
      "npx",
      ["--yes", "skills", "add", spec.source, ...(spec.args ?? [])],
      {
        cwd,
        stderr: "inherit",
        stdout: "inherit",
      }
    );
  }
}

export async function initPipelineProject(
  options: PipelineInitOptions = {}
): Promise<PipelineInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const skillInstaller = options.skillInstaller ?? installDefaultSkillsWithCli;
  await skillInstaller(DEFAULT_SKILL_INSTALLS, cwd);
  const result = await installCommands({ cwd, host: "all" });
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
