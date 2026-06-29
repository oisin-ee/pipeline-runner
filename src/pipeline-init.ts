import { execa } from "execa";
import { AGENT_SKILL_SOURCE } from "./agent-assets";
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

const DEFAULT_SKILL_INSTALL_SOURCE = AGENT_SKILL_SOURCE;
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
  check?: boolean;
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
  hookInstaller?: PipelineHookInstaller;
  rulesInstaller?: PipelineRulesInstaller;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
}

export interface PipelineInitFormatMode {
  check?: boolean;
  dryRun?: boolean;
}

interface PipelineInitInstallerFlags {
  check?: boolean;
  dryRun?: boolean;
  force: boolean;
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
  const { check, dryRun } = options;
  const installerFlags = initInstallerFlags(options);
  // Skills come from `npx skills add` (network, externally managed); they are not
  // part of the generated harness, so --check/--dry-run skip them entirely.
  if (!(check || dryRun)) {
    const skillInstaller = options.skillInstaller ?? installDefaultSkills;
    await skillInstaller(cwd);
  }
  const result = await installCommands({ cwd, host: "all", ...installerFlags });
  const hookInstaller =
    options.hookInstaller ?? (() => installHooks(installerFlags));
  const hooks = await hookInstaller(cwd);
  const rulesInstaller =
    options.rulesInstaller ?? (() => installRules(installerFlags));
  const rulesResult = await rulesInstaller(cwd);
  return {
    files: [
      ...result.items.map((item) => item.path),
      ...hookInstallerFiles(hooks),
      ...rulesResult.items.map((item) => item.path),
    ],
  };
}

function initInstallerFlags(
  options: PipelineInitOptions
): PipelineInitInstallerFlags {
  const { check, dryRun } = options;
  return {
    check,
    dryRun,
    force: options.force ?? !(check || dryRun),
  };
}

const INIT_RESULT_COPY = {
  install: {
    headline: "Initialized package-owned pipeline support:",
    fileVerb: "generated",
    footer: "no repo-local pipeline config files were created",
  },
  check: {
    headline: "Verified package-owned pipeline support is current:",
    fileVerb: "current",
    footer: "harness verified; no changes written",
  },
  dryRun: {
    headline: "Planned package-owned pipeline support:",
    fileVerb: "would generate",
    footer: "dry run; no changes written",
  },
} as const;

function initResultMode(
  mode: PipelineInitFormatMode
): keyof typeof INIT_RESULT_COPY {
  if (mode.check) {
    return "check";
  }
  if (mode.dryRun) {
    return "dryRun";
  }
  return "install";
}

export function formatPipelineInitResult(
  result: PipelineInitResult,
  mode: PipelineInitFormatMode = {}
): string {
  const copy = INIT_RESULT_COPY[initResultMode(mode)];
  return [
    copy.headline,
    "per-machine harness globally (user/global skills + ~/.claude, ~/.config/opencode, ~/.codex); global instruction files generated via rulesync from oisin-ee/agent/rules; inherited by every repo with no per-repo copy",
    ...result.files.map((path) => `${copy.fileVerb} ${path}`),
    copy.footer,
  ].join("\n");
}
