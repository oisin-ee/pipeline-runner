import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { Option } from "effect";

/**
 * PIPE-83.4: git-worktree isolation for parallel candidate nodes. Each parallel
 * child runs in its own worktree on an auto-named branch so concurrent edits do
 * not collide. Teardown is idempotent and crash-safe: a worktree with dirty or
 * unpushed work is RETAINED (never deleted), and orphaned worktrees are GC'd on
 * startup using the same safety guard. A worktree is NOT a sandbox — node_modules
 * and build state are shared; real isolation remains k8s mode.
 */

const WORKTREE_ROOT = ".pipeline/worktrees";
const REGISTRY_DIR = join(WORKTREE_ROOT, "registry");
const OWNER = "oisin-pipeline";

// PIPE-83.14: a git worktree only checks out COMMITTED files, but the opencode
// agent + command definitions (.opencode/agents, .opencode/command) are
// install-generated and gitignored. The opencode SDK throws (createUserMessage
// UnknownError) when a prompt selects an agent that doesn't exist in the session
// directory — unlike the CLI, which falls back to the default agent. So a
// candidate worktree must carry these generated resources or every agent prompt
// in it fails. Copied from the parent repo on worktree creation.
const GENERATED_WORKTREE_RESOURCES = [
  join(".opencode", "agents"),
  join(".opencode", "command"),
];

const provisionGeneratedResources = (
  repoRoot: string,
  worktreePath: string
): void => {
  for (const relativePath of GENERATED_WORKTREE_RESOURCES) {
    const source = join(repoRoot, relativePath);
    const target = join(worktreePath, relativePath);
    if (existsSync(source) && !existsSync(target)) {
      cpSync(source, target, { recursive: true });
    }
  }
};

const copyFileInto = (
  fromRoot: string,
  toRoot: string,
  relativePath: string
): void => {
  const source = join(fromRoot, relativePath);
  if (!existsSync(source)) {
    return;
  }
  const dest = join(toRoot, relativePath);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
};

export type WorktreeState =
  | "active"
  | "removed"
  | "retained-dirty"
  | "retained-unpushed";

export interface WorktreeLease {
  baseSha: string;
  branch: string;
  leaseId: string;
  path: string;
  release: () => WorktreeState;
}

export interface CreateWorktreeOptions {
  childNodeId: string;
  parentNodeId: string;
  repoRoot: string;
  runId?: string;
}

interface WorktreeManifest {
  baseSha: string;
  branch: string;
  childNodeId: string;
  leaseId: string;
  owner: string;
  parentNodeId: string;
  path: string;
  runId?: string;
  schemaVersion: 1;
  state: WorktreeState | "creating";
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const changedWorktreeFiles = (worktreePath: string): string[] => {
  const modified = git(worktreePath, ["diff", "--name-only", "HEAD"]);
  const untracked = git(worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return [...modified.split("\n"), ...untracked.split("\n")].filter(Boolean);
};

const sanitize = (id: string): string =>
  id.replaceAll(/[^A-Za-z0-9._-]/gu, "-");

const childWorktreeRelPath = (
  parentNodeId: string,
  childNodeId: string,
  runId?: string
): string =>
  join(
    WORKTREE_ROOT,
    "trees",
    sanitize(runId ?? "local"),
    sanitize(parentNodeId),
    sanitize(childNodeId)
  );

/**
 * PIPE-83.14: promote a best-of-N winner's edits from its (retained) worktree
 * back into the main worktree, so downstream nodes (tests, verification) see the
 * selected candidate's changes. Copies modified + untracked files; no-op if the
 * worktree is gone. Returns the promoted file paths.
 */
export const promoteWorktreeChanges = (
  repoRoot: string,
  parentNodeId: string,
  childNodeId: string,
  runId?: string
): string[] => {
  const worktreePath = join(
    repoRoot,
    childWorktreeRelPath(parentNodeId, childNodeId, runId)
  );
  if (!existsSync(worktreePath)) {
    return [];
  }
  const files = changedWorktreeFiles(worktreePath);
  for (const relativePath of files) {
    copyFileInto(worktreePath, repoRoot, relativePath);
  }
  return files;
};

const writeManifest = (path: string, manifest: WorktreeManifest): void => {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
};

const readManifest = (path: string): WorktreeManifest =>
  JSON.parse(readFileSync(path, "utf-8")) as WorktreeManifest;

/** Returns a retention reason when the worktree must be kept, else undefined. */
const retentionState = (
  absPath: string,
  baseSha: string
): Option.Option<"retained-dirty" | "retained-unpushed"> => {
  const dirty = git(absPath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (dirty.length > 0) {
    return Option.some("retained-dirty");
  }
  const head = git(absPath, ["rev-parse", "HEAD"]);
  if (head !== baseSha) {
    return Option.some("retained-unpushed");
  }
  return Option.none();
};

/** Idempotent, crash-safe teardown. Retains (never deletes) dirty/unpushed work. */
const releaseWorktree = (
  repoRoot: string,
  manifestPath: string
): WorktreeState => {
  if (!existsSync(manifestPath)) {
    return "removed";
  }
  const manifest = readManifest(manifestPath);
  const absPath = join(repoRoot, manifest.path);
  git(repoRoot, ["worktree", "prune"]);
  if (!existsSync(absPath)) {
    writeManifest(manifestPath, { ...manifest, state: "removed" });
    return "removed";
  }
  const guarded = retentionState(absPath, manifest.baseSha);
  if (Option.isSome(guarded)) {
    writeManifest(manifestPath, { ...manifest, state: guarded.value });
    return guarded.value;
  }
  git(repoRoot, ["worktree", "remove", "--force", absPath]);
  git(repoRoot, ["branch", "-D", manifest.branch]);
  writeManifest(manifestPath, { ...manifest, state: "removed" });
  return "removed";
};

export const createChildWorktree = (
  opts: CreateWorktreeOptions
): WorktreeLease => {
  const runSeg = sanitize(opts.runId ?? "local");
  const parentSeg = sanitize(opts.parentNodeId);
  const childSeg = sanitize(opts.childNodeId);
  const baseSha = git(opts.repoRoot, ["rev-parse", "HEAD"]);
  const relPath = childWorktreeRelPath(
    opts.parentNodeId,
    opts.childNodeId,
    opts.runId
  );
  const absPath = join(opts.repoRoot, relPath);
  const branch = `pipeline/worktrees/${runSeg}/${parentSeg}/${childSeg}`;
  const leaseId = `${runSeg}__${parentSeg}__${childSeg}`;
  const registryAbs = join(opts.repoRoot, REGISTRY_DIR);
  mkdirSync(registryAbs, { recursive: true });
  const manifestPath = join(registryAbs, `${leaseId}.json`);

  const manifest: WorktreeManifest = {
    baseSha,
    branch,
    childNodeId: opts.childNodeId,
    leaseId,
    owner: OWNER,
    parentNodeId: opts.parentNodeId,
    path: relPath,
    runId: opts.runId,
    schemaVersion: 1,
    state: "creating",
  };
  writeManifest(manifestPath, manifest);

  // Idempotent: reuse an existing worktree for this lease rather than re-adding.
  if (!existsSync(absPath)) {
    git(opts.repoRoot, ["worktree", "add", "-b", branch, absPath, baseSha]);
  }
  provisionGeneratedResources(opts.repoRoot, absPath);
  writeManifest(manifestPath, { ...manifest, state: "active" });

  return {
    baseSha,
    branch,
    leaseId,
    path: absPath,
    release: () => releaseWorktree(opts.repoRoot, manifestPath),
  };
};

/** Startup GC: release every pipeline-owned lease using the same safety guard. */
export const gcParallelWorktrees = (repoRoot: string): WorktreeState[] => {
  const registryAbs = join(repoRoot, REGISTRY_DIR);
  if (!existsSync(registryAbs)) {
    return [];
  }
  const results = readdirSync(registryAbs)
    .toSorted()
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(registryAbs, file))
    .filter((manifestPath) => readManifest(manifestPath).owner === OWNER)
    .map((manifestPath) => releaseWorktree(repoRoot, manifestPath));
  git(repoRoot, ["worktree", "prune"]);
  return results;
};
