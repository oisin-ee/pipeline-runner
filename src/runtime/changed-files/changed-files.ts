import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFilesSnapshot } from "../contracts";

export function snapshotChangedFiles(
  worktreePath: string
): ChangedFilesSnapshot {
  try {
    const stdout = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
      {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const files = new Set(parsePorcelainStatus(stdout));
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

function parsePorcelainStatus(stdout: string): string[] {
  const entries = stdout.split("\0").filter(Boolean);
  return entries.flatMap((entry, index) =>
    isRenameSourceEntry(entries, index) ? [] : pathFromPorcelainEntry(entry)
  );
}

function isRenameSourceEntry(entries: string[], index: number): boolean {
  const previousStatus = entries[index - 1]?.slice(0, 2);
  return Boolean(previousStatus && isRenameOrCopyStatus(previousStatus));
}

function isRenameOrCopyStatus(status: string): boolean {
  return status.startsWith("R") || status.startsWith("C");
}

function pathFromPorcelainEntry(entry: string): string[] {
  const path = entry.slice(3);
  return path ? [path] : [];
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
