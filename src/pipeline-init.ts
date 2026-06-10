import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { installCommands } from "./install-commands";
import { resolvePackageAssetPath } from "./package-assets";

export type PipelineSkillInstaller = (cwd: string) => Promise<void>;

export interface PipelineInitOptions {
  cwd?: string;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
}

async function installDefaultSkillsFromPackage(cwd: string): Promise<void> {
  const source = resolvePackageAssetPath(".agents/skills");
  const target = join(cwd, ".agents", "skills");
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true, recursive: true });
}

export async function initPipelineProject(
  options: PipelineInitOptions = {}
): Promise<PipelineInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const skillInstaller =
    options.skillInstaller ?? installDefaultSkillsFromPackage;
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
