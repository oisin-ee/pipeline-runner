import { installCommands } from "./install-commands";

export interface PipelineInitOptions {
  check?: boolean;
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
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

/**
 * `moka init` installs only Moka's own host adapters
 * (`/moka-execute|inspect|quick` command surfaces, native-agent projections,
 * and singleton MCP gateway host config) globally for Claude Code, Codex, and
 * OpenCode. The shared agent harness
 * (skills, agent hooks, and global instruction rules) is no longer installed by
 * Moka — it is provisioned from `oisin-ee/agent` via chezmoi (the dotfiles'
 * `.chezmoiexternal` clone + `run_onchange` harness installer). Keeping moka's
 * host adapters here means the runner image (and local dev) still gets the
 * `/moka-*` entrypoints after `chezmoi apply` lays down the harness.
 */
export async function initPipelineProject(
  options: PipelineInitOptions = {}
): Promise<PipelineInitResult> {
  const cwd = options.cwd ?? process.cwd();
  const installerFlags = initInstallerFlags(options);
  const result = await installCommands({ cwd, host: "all", ...installerFlags });
  return { files: result.items.map((item) => item.path) };
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
    headline: "Initialized Moka host adapters:",
    fileVerb: "generated",
    footer: "no repo-local pipeline config files were created",
  },
  check: {
    headline: "Verified Moka host adapters are current:",
    fileVerb: "current",
    footer: "adapters verified; no changes written",
  },
  dryRun: {
    headline: "Planned Moka host adapters:",
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
    [
      "per-machine Moka host adapters (/moka-execute|inspect|quick command surfaces, native-agent projections,",
      "and gateway config) installed globally (~/.claude, ~/.config/opencode, ~/.codex); the shared agent harness",
      "(skills, hooks, instruction rules) comes from oisin-ee/agent via chezmoi, not Moka",
    ].join(" "),
    ...result.files.map((path) => `${copy.fileVerb} ${path}`),
    copy.footer,
  ].join("\n");
}
