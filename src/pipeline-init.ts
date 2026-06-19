import { execa } from "execa";
import { installCommands } from "./install-commands";
import { type InstallHooksResult, installHooks } from "./install-hooks";
import { installRules } from "./install-rules";

export type PipelineSkillInstaller = (cwd: string) => Promise<void>;
export type PipelineHookInstaller = (
  cwd: string
) => Promise<Pick<InstallHooksResult, "items"> | { files: string[] }>;

export type PipelineRulesInstaller = (
  cwd: string
) => Promise<{ items: { path: string }[] }>;

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
  "--global",
];

export interface PipelineInitOptions {
  cwd?: string;
  hookInstaller?: PipelineHookInstaller;
  rulesInstaller?: PipelineRulesInstaller;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
}

export interface RefreshAgentHarnessesOptions extends PipelineInitOptions {}

export interface RefreshAgentHarnessesResult extends PipelineInitResult {}

async function installDefaultSkills(cwd: string): Promise<void> {
  try {
    await execa(
      "npx",
      [
        "--yes",
        "skills",
        "add",
        DEFAULT_SKILL_INSTALL_SOURCE,
        ...SKILL_INSTALL_AGENT_ARGS,
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

function installDefaultHooks(): Promise<InstallHooksResult> {
  // moka owns the per-machine harness: init/refresh (re)write it on every run, so
  // force past the "manually edited" guard the same way the command install does
  // (installCommands force:true below). Without this, a pre-baked or version-skewed
  // ~/.claude/settings.json makes the runner's `moka init` setup step exit 1.
  return installHooks({ force: true });
}

function hookInstallerFiles(
  result: Pick<InstallHooksResult, "items"> | { files: string[] }
): string[] {
  return "items" in result
    ? result.items.map((item) => item.path)
    : result.files;
}

export async function initPipelineProject(
  options: PipelineInitOptions = {}
): Promise<PipelineInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const skillInstaller = options.skillInstaller ?? installDefaultSkills;
  const hookInstaller = options.hookInstaller ?? installDefaultHooks;
  const rulesInstaller =
    options.rulesInstaller ?? ((_target) => installRules({}));
  await skillInstaller(cwd);
  const result = await installCommands({
    cwd,
    force: true,
    host: "all",
  });
  const hooks = await hookInstaller(cwd);
  const rulesResult = await rulesInstaller(cwd);
  return {
    files: [
      ...result.items.map((item) => item.path),
      ...hookInstallerFiles(hooks),
      ...rulesResult.items.map((item) => item.path),
    ],
  };
}

export function refreshAgentHarnesses(
  options: RefreshAgentHarnessesOptions = {}
): Promise<RefreshAgentHarnessesResult> {
  return initPipelineProject(options);
}

export function formatPipelineInitResult(result: PipelineInitResult): string {
  return [
    "Initialized package-owned pipeline support:",
    "installed the per-machine harness globally (user/global skills + ~/.claude, ~/.config/opencode, ~/.codex); global instruction files generated via rulesync from oisin-ee/rules; inherited by every repo with no per-repo copy",
    ...result.files.map((path) => `generated ${path}`),
    "no repo-local pipeline config files were created",
  ].join("\n");
}

export function formatRefreshAgentHarnessesResult(
  result: RefreshAgentHarnessesResult
): string {
  return [
    formatPipelineInitResult(result),
    "global harness refreshed; no repo commit (per-machine install)",
  ].join("\n");
}
