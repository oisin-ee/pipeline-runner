import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffChangedFiles, snapshotChangedFiles } from "./changed-files";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const tempProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-changed-files-"));
  tempDirs.push(dir);
  return dir;
};

const git = (dir: string, args: string[]): void => {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
};

describe("changed file snapshots", () => {
  it("returns an empty snapshot outside a git worktree", () => {
    const dir = tempProject();

    expect(snapshotChangedFiles(dir)).toMatchObject({
      files: new Set(),
      fingerprints: new Map(),
    });
  });

  it("detects already-dirty tracked files that change during a node", async () => {
    const dir = tempProject();
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "Test User"]);
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n");
    git(dir, ["add", "app.ts"]);
    git(dir, ["commit", "-m", "initial"]);

    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    const before = snapshotChangedFiles(dir);
    writeFileSync(join(dir, "app.ts"), "export const value = 3;\n");
    const after = snapshotChangedFiles(dir);

    expect(diffChangedFiles(before, after, dir).files).toEqual(new Set(["app.ts"]));
  });
});
