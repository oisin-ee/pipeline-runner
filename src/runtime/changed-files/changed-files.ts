import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { ChangedFilesSnapshot } from "../contracts";

export async function snapshotChangedFiles(
  worktreePath: string
): Promise<ChangedFilesSnapshot> {
  try {
    const status = await simpleGit({ baseDir: worktreePath }).status();
    const files = new Set(
      status.files.map((file) => file.path).filter(Boolean)
    );
    return {
      files,
      fingerprints: new Map(
        [...files].map((file) => [file, fileFingerprint(worktreePath, file)])
      ),
    };
  } catch {
    return { files: new Set(), fingerprints: new Map() };
  }
}

export function diffChangedFiles(
  before: ChangedFilesSnapshot,
  after: ChangedFilesSnapshot,
  worktreePath: string
): ChangedFilesSnapshot {
  const candidateFiles = new Set([...before.files, ...after.files]);
  const files = [...candidateFiles].filter(
    (file) =>
      !before.files.has(file) ||
      before.fingerprints.get(file) !==
        (after.fingerprints.get(file) ?? fileFingerprint(worktreePath, file))
  );
  return {
    files: new Set(files),
    fingerprints: new Map(
      files.map((file) => [
        file,
        after.fingerprints.get(file) ?? fileFingerprint(worktreePath, file),
      ])
    ),
  };
}

function fileFingerprint(worktreePath: string, file: string): string {
  const fullPath = join(worktreePath, file);
  if (!existsSync(fullPath)) {
    return "missing";
  }
  return createHash("sha256").update(readFileSync(fullPath)).digest("hex");
}
