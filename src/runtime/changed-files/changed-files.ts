import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { ChangedFilesSnapshot } from "../contracts";
import {
  GitPorcelainService,
  GitPorcelainServiceLive,
} from "../services/git-porcelain-service";

export function snapshotChangedFiles(
  worktreePath: string
): ChangedFilesSnapshot {
  return Effect.runSync(
    Effect.provide(
      snapshotChangedFilesEffect(worktreePath),
      GitPorcelainServiceLive
    )
  );
}

function snapshotChangedFilesEffect(
  worktreePath: string
): Effect.Effect<ChangedFilesSnapshot, never, GitPorcelainService> {
  return Effect.gen(function* () {
    const git = yield* GitPorcelainService;
    const stdout = yield* git
      .statusPorcelain(worktreePath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    const files = new Set(parsePorcelainStatus(stdout));
    return changedFilesSnapshot(worktreePath, files);
  });
}

function changedFilesSnapshot(
  worktreePath: string,
  files: Set<string>
): ChangedFilesSnapshot {
  return {
    files,
    fingerprints: new Map(
      [...files].map((file) => [file, fileFingerprint(worktreePath, file)])
    ),
  };
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
