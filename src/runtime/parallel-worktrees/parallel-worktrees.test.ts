import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChildWorktree, gcParallelWorktrees } from "./parallel-worktrees";

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { force: true, recursive: true });
  }
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "moka-wt-"));
  repos.push(dir);
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.dev"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  return dir;
}

function gitIn(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

describe("parallel-worktrees", () => {
  it("creates a worktree on an auto-named branch with the base checkout", () => {
    const repo = tempRepo();
    const lease = createChildWorktree({
      childNodeId: "cand-1",
      parentNodeId: "green",
      repoRoot: repo,
      runId: "run1",
    });

    expect(existsSync(lease.path)).toBe(true);
    expect(lease.branch).toBe("pipeline/worktrees/run1/green/cand-1");
    expect(existsSync(join(lease.path, "a.txt"))).toBe(true);
  });

  it("removes a clean worktree and is idempotent", () => {
    const repo = tempRepo();
    const lease = createChildWorktree({
      childNodeId: "c",
      parentNodeId: "p",
      repoRoot: repo,
      runId: "r",
    });

    expect(lease.release()).toBe("removed");
    expect(existsSync(lease.path)).toBe(false);
    expect(lease.release()).toBe("removed");
  });

  it("retains a dirty worktree instead of deleting it", () => {
    const repo = tempRepo();
    const lease = createChildWorktree({
      childNodeId: "c",
      parentNodeId: "p",
      repoRoot: repo,
      runId: "r",
    });
    writeFileSync(join(lease.path, "uncommitted.txt"), "wip\n");

    expect(lease.release()).toBe("retained-dirty");
    expect(existsSync(lease.path)).toBe(true);
  });

  it("retains a worktree with unpushed commits", () => {
    const repo = tempRepo();
    const lease = createChildWorktree({
      childNodeId: "c",
      parentNodeId: "p",
      repoRoot: repo,
      runId: "r",
    });
    writeFileSync(join(lease.path, "a.txt"), "changed\n");
    gitIn(lease.path, ["add", "-A"]);
    gitIn(lease.path, ["commit", "-q", "-m", "child work"]);

    expect(lease.release()).toBe("retained-unpushed");
    expect(existsSync(lease.path)).toBe(true);
  });

  it("GCs clean orphans but retains dirty ones", () => {
    const repo = tempRepo();
    const clean = createChildWorktree({
      childNodeId: "clean",
      parentNodeId: "p",
      repoRoot: repo,
      runId: "r",
    });
    const dirty = createChildWorktree({
      childNodeId: "dirty",
      parentNodeId: "p",
      repoRoot: repo,
      runId: "r",
    });
    writeFileSync(join(dirty.path, "x.txt"), "y\n");

    const states = gcParallelWorktrees(repo).sort();

    expect(states).toContain("removed");
    expect(states).toContain("retained-dirty");
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
  });
});
