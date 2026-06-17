import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { installCommands } from "./install-commands";
import {
  DEFAULT_HARNESS_SCOPE,
  type HarnessScope,
} from "./install-commands/shared";

export type PipelineSkillInstaller = (cwd: string) => Promise<void>;

/**
 * Where the default skill set is installed. "project" vendors a repo-local
 * copy (the legacy `--copy` + skills-lock.json path); "personal" installs once
 * at user/global scope so every repo the user opens inherits the skills with
 * no per-repo copy and no project lockfile.
 */
export type PipelineSkillScope = "project" | "personal";

/**
 * The harness scope drives every generated resource at once: skills, host
 * commands/agents, and config. "global" (default) installs the single
 * per-machine harness (user/global skills + ~/.claude, ~/.config/opencode,
 * ~/.codex host config); "project" vendors everything repo-local.
 */
function skillScopeFor(scope: HarnessScope): PipelineSkillScope {
  return scope === "global" ? "personal" : "project";
}

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

function skillInstallArgs(scope: PipelineSkillScope): string[] {
  // personal → user-global install (inherited, no per-repo copy/lockfile);
  // project → repo-local vendored copy (the legacy default).
  return scope === "personal"
    ? [...SKILL_INSTALL_AGENT_ARGS, "--global"]
    : [...SKILL_INSTALL_AGENT_ARGS, "--copy"];
}

export interface PipelineInitOptions {
  cwd?: string;
  scope?: HarnessScope;
  skillInstaller?: PipelineSkillInstaller;
}

export interface PipelineInitResult {
  files: string[];
  scope: HarnessScope;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type PipelineCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; reject?: boolean }
) => Promise<CommandResult>;

export interface RefreshAgentHarnessesOptions extends PipelineInitOptions {
  commandRunner?: PipelineCommandRunner;
  commitMessage?: string;
}

export interface RefreshAgentHarnessesResult extends PipelineInitResult {
  commitMessage: string;
  committed: boolean;
}

interface RefreshAgentHarnessesContext {
  readonly commandRunner: PipelineCommandRunner;
  readonly commitMessage: string;
  readonly cwd: string;
}

const DEFAULT_HARNESS_COMMIT_MESSAGE = "chore: update agent harnesses";

const OWNED_HARNESS_PATHS = [
  ".agents/skills",
  ".claude/agents",
  ".claude/commands",
  ".claude/settings.json",
  ".claude/skills",
  ".codex/skills",
  ".opencode",
  "AGENTS.md",
  "skills-lock.json",
] as const;

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
  const scope = options.scope ?? DEFAULT_HARNESS_SCOPE;
  const skillInstaller =
    options.skillInstaller ??
    ((target) => installDefaultSkills(target, skillScopeFor(scope)));
  await skillInstaller(cwd);
  const result = await installCommands({
    cwd,
    force: true,
    host: "all",
    scope,
  });
  return {
    files: result.items.map((item) => item.path),
    scope,
  };
}

export async function refreshAgentHarnesses(
  options: RefreshAgentHarnessesOptions = {}
): Promise<RefreshAgentHarnessesResult> {
  const context = refreshAgentHarnessesContext(options);
  const init = await initPipelineProject({
    cwd: context.cwd,
    scope: options.scope,
    skillInstaller: options.skillInstaller,
  });
  // Global installs write to per-machine host dirs with nothing repo-local to
  // stage, so the git commit only applies to project scope.
  const committed =
    init.scope === "project"
      ? await refreshAgentHarnessesCommitResult(context)
      : false;
  return { ...init, commitMessage: context.commitMessage, committed };
}

function refreshAgentHarnessesContext(
  options: RefreshAgentHarnessesOptions
): RefreshAgentHarnessesContext {
  return {
    commandRunner: options.commandRunner ?? runCommand,
    commitMessage: options.commitMessage ?? DEFAULT_HARNESS_COMMIT_MESSAGE,
    cwd: options.cwd ?? process.cwd(),
  };
}

async function refreshAgentHarnessesCommitResult(
  context: RefreshAgentHarnessesContext
): Promise<boolean> {
  await assertGitWorktree(context.cwd, context.commandRunner);
  return stageableOwnedPathsExist(context.cwd)
    ? await commitOwnedHarnessRefresh(
        context.cwd,
        context.commandRunner,
        context.commitMessage
      )
    : false;
}

export function formatPipelineInitResult(result: PipelineInitResult): string {
  const summaryLine =
    result.scope === "global"
      ? "installed the per-machine harness globally (user/global skills + ~/.claude, ~/.config/opencode, ~/.codex); inherited by every repo with no per-repo copy"
      : "installed default skills and host config repo-local";
  return [
    "Initialized package-owned pipeline support:",
    summaryLine,
    ...result.files.map((path) => `generated ${path}`),
    "no repo-local pipeline config files were created",
  ].join("\n");
}

function refreshCommitSummary(result: RefreshAgentHarnessesResult): string {
  if (result.scope === "global") {
    return "global harness refreshed; no repo commit (per-machine install)";
  }
  if (result.committed) {
    return `committed refreshed harnesses: ${result.commitMessage}`;
  }
  return "refreshed harnesses already current; no commit created";
}

export function formatRefreshAgentHarnessesResult(
  result: RefreshAgentHarnessesResult
): string {
  return [formatPipelineInitResult(result), refreshCommitSummary(result)].join(
    "\n"
  );
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; reject?: boolean }
): Promise<CommandResult> {
  const result = await execa(command, args, {
    cwd: options.cwd,
    reject: options.reject ?? true,
  });
  return {
    exitCode: result.exitCode ?? 0,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

async function assertGitWorktree(
  cwd: string,
  commandRunner: PipelineCommandRunner
): Promise<void> {
  await commandRunner("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
}

async function commitOwnedHarnessRefresh(
  cwd: string,
  commandRunner: PipelineCommandRunner,
  commitMessage: string
): Promise<boolean> {
  await stageOwnedHarnessPaths(cwd, commandRunner);
  await assertOnlyOwnedHarnessFilesStaged(cwd, commandRunner);
  if (!(await hasStagedChanges(cwd, commandRunner))) {
    return false;
  }
  await commandRunner("git", ["commit", "--no-verify", "-m", commitMessage], {
    cwd,
  });
  return true;
}

async function hasStagedChanges(
  cwd: string,
  commandRunner: PipelineCommandRunner
): Promise<boolean> {
  const diff = await commandRunner("git", ["diff", "--cached", "--quiet"], {
    cwd,
    reject: false,
  });
  return diff.exitCode !== 0;
}

async function assertOnlyOwnedHarnessFilesStaged(
  cwd: string,
  commandRunner: PipelineCommandRunner
): Promise<void> {
  const result = await commandRunner(
    "git",
    ["diff", "--cached", "--name-only"],
    {
      cwd,
    }
  );
  const stagedFiles = result.stdout
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const unrelatedFiles = stagedFiles.filter(
    (path) => !isOwnedHarnessPath(path)
  );
  if (unrelatedFiles.length === 0) {
    return;
  }
  throw new Error(
    [
      "Refusing to commit because unrelated files are already staged.",
      ...unrelatedFiles.map((path) => `- ${path}`),
      "Unstage unrelated files before running `moka refresh-harnesses`.",
    ].join("\n")
  );
}

function isOwnedHarnessPath(path: string): boolean {
  return OWNED_HARNESS_PATHS.some(
    (ownedPath) => path === ownedPath || path.startsWith(`${ownedPath}/`)
  );
}

function existingOwnedPaths(cwd: string): string[] {
  return OWNED_HARNESS_PATHS.filter((path) => existsSync(join(cwd, path)));
}

function stageableOwnedPathsExist(cwd: string): boolean {
  return existingOwnedPaths(cwd).length > 0;
}

async function stageOwnedHarnessPaths(
  cwd: string,
  commandRunner: PipelineCommandRunner
): Promise<void> {
  await commandRunner("git", ["add", "-A", "--", ...existingOwnedPaths(cwd)], {
    cwd,
  });
}
