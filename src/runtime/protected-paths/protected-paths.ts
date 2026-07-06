import { globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Option } from "effect";

/**
 * PIPE-90.12 — read-only criteria + adjudicating-tests boundary (orchestrator
 * design principle #7). The executing node agent is UNTRUSTED: it runs in the
 * worktree with broad write access. It must NOT author or weaken its ticket's
 * acceptance criteria or the tests that adjudicate it (anti reward-hacking).
 *
 * This module is the single owner of the protected-set computation. A profile
 * declares `filesystem.protected` glob patterns; both transports consume them:
 *   - the opencode permission generator emits per-path `deny` overlays
 *     ({@link protectedPermissionOverlay}); and
 *   - the runtime subprocess seam snapshots the matched files before launch and
 *     reverts + reports any change afterwards ({@link createProtectedPathGuard}).
 *
 * Enforcement is on the *effect* (a protected file changed), not the mechanism,
 * so it covers `edit`/`write`, bash redirection (`>>`), deletion (`rm`), path
 * traversal (`../`), and symlink write-through alike — every vector resolves to
 * the same protected file, whose bytes are re-checked after the agent runs.
 */
export interface ProtectedPathViolation {
  /** Whether the protected file was content-modified or removed. */
  readonly kind: "modified" | "deleted";
  /** Worktree-relative path of the protected file the agent touched. */
  readonly path: string;
}

export interface ProtectedPathGuard {
  /** The protected glob patterns under guard (empty when none configured). */
  readonly patterns: readonly string[];
  /**
   * Re-read every snapshotted protected file. Any file whose bytes changed or
   * that was deleted is restored to its captured content and reported as a
   * violation. Returns the (possibly empty) list of violations so the caller
   * can surface and fail — never silently passes.
   */
  verifyAndRestore(): readonly ProtectedPathViolation[];
}

interface ProtectedSnapshotEntry {
  readonly absPath: string;
  readonly bytes: Buffer;
  readonly relPath: string;
}

/**
 * Build the per-path `deny` overlay shared by the transports' permission maps.
 * Keeping the pattern → action shaping here makes the protected set a single
 * owner rather than two ad-hoc maps.
 */
export const protectedPermissionOverlay = (patterns: readonly string[]): Record<string, "deny"> =>
  Object.fromEntries(patterns.map((pattern) => [pattern, "deny"]));

const restoreEntry = (entry: ProtectedSnapshotEntry): void => {
  // Remove whatever now sits at the path (regular file, symlink, or directory
  // the agent may have substituted) before writing the captured bytes back as a
  // plain file, so symlink/`../` substitutions cannot survive the revert.
  rmSync(entry.absPath, { force: true, recursive: true });
  mkdirSync(dirname(entry.absPath), { recursive: true });
  writeFileSync(entry.absPath, entry.bytes);
};

const regularFileBytes = (absPath: string): Option.Option<Buffer> => {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absPath);
  } catch {
    return Option.none();
  }
  if (!stats.isFile()) {
    return Option.none();
  }
  try {
    return Option.some(readFileSync(absPath));
  } catch {
    return Option.none();
  }
};

const verifyEntry = (entry: ProtectedSnapshotEntry): Option.Option<ProtectedPathViolation> => {
  const current = regularFileBytes(entry.absPath);
  if (Option.isNone(current)) {
    restoreEntry(entry);
    return Option.some({ kind: "deleted", path: entry.relPath });
  }
  if (current.value.equals(entry.bytes)) {
    return Option.none();
  }
  restoreEntry(entry);
  return Option.some({ kind: "modified", path: entry.relPath });
};

const verifyAndRestoreSnapshot = (snapshot: readonly ProtectedSnapshotEntry[]): ProtectedPathViolation[] => {
  const violations: ProtectedPathViolation[] = [];
  for (const entry of snapshot) {
    const violation = verifyEntry(entry);
    if (Option.isSome(violation)) {
      violations.push(violation.value);
    }
  }
  return violations;
};

const isWithinRoot = (root: string, absPath: string): boolean => {
  const rel = relative(root, absPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
};

const snapshotEntry = (root: string, match: string): Option.Option<ProtectedSnapshotEntry> => {
  const absPath = resolve(root, match);
  if (!isWithinRoot(root, absPath)) {
    return Option.none();
  }
  const bytes = regularFileBytes(absPath);
  if (Option.isNone(bytes)) {
    return Option.none();
  }
  return Option.some({
    absPath,
    bytes: bytes.value,
    relPath: relative(root, absPath),
  });
};

const snapshotProtectedFiles = (worktreePath: string, patterns: readonly string[]): ProtectedSnapshotEntry[] => {
  if (patterns.length === 0) {
    return [];
  }
  const root = resolve(worktreePath);
  const entries = new Map<string, ProtectedSnapshotEntry>();
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: root })) {
      const entry = snapshotEntry(root, match);
      if (Option.isSome(entry)) {
        entries.set(entry.value.absPath, entry.value);
      }
    }
  }
  return [...entries.values()];
};

/**
 * Snapshot the files matching `patterns` inside `worktreePath` and return a
 * guard that can later revert any tampering. Configuring no patterns yields a
 * no-op guard (no globbing, no filesystem reads).
 */
export const createProtectedPathGuard = (worktreePath: string, patterns?: readonly string[]): ProtectedPathGuard => {
  const safePatterns = (patterns ?? []).filter((pattern) => pattern.trim().length > 0);
  const snapshot = snapshotProtectedFiles(worktreePath, safePatterns);
  return {
    patterns: safePatterns,
    verifyAndRestore: () => verifyAndRestoreSnapshot(snapshot),
  };
};
