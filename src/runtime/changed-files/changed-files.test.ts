import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { diffChangedFiles, snapshotChangedFiles } from "./changed-files";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-changed-files-"));
  tempDirs.push(dir);
  return dir;
}

describe("changed file snapshots", () => {
  it("returns an empty snapshot outside a git worktree", async () => {
    const dir = tempProject();

    await expect(snapshotChangedFiles(dir)).resolves.toMatchObject({
      files: new Set(),
      fingerprints: new Map(),
    });
  });

  it("detects already-dirty tracked files that change during a node", async () => {
    const dir = tempProject();
    const git = simpleGit({ baseDir: dir });
    await git.init();
    await git.addConfig("user.email", "test@example.com");
    await git.addConfig("user.name", "Test User");
    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n");
    await git.add(["app.ts"]);
    await git.commit("initial");

    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    const before = await snapshotChangedFiles(dir);
    writeFileSync(join(dir, "app.ts"), "export const value = 3;\n");
    const after = await snapshotChangedFiles(dir);

    expect(diffChangedFiles(before, after, dir).files).toEqual(
      new Set(["app.ts"])
    );
  });
});
