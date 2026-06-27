import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OPENCODE_EXCLUDES = [
  "node_modules/",
  ".opencode/node_modules/",
  ".mastra/",
  "dist/",
  "build/",
  "coverage/",
];
const LINE_RE = /\r?\n/;

export function ensureOpencodeGitExcludes(worktreePath: string): void {
  const excludePath = join(worktreePath, ".git", "info", "exclude");
  if (!existsSync(excludePath)) {
    return;
  }
  const existing = readFileSync(excludePath, "utf8");
  const missing = OPENCODE_EXCLUDES.filter(
    (entry) => !existing.split(LINE_RE).includes(entry)
  );
  if (missing.length === 0) {
    return;
  }
  mkdirSync(join(worktreePath, ".git", "info"), { recursive: true });
  appendFileSync(
    excludePath,
    `${existing.endsWith("\n") ? "" : "\n"}# oisin-pipeline opencode excludes\n${missing.join("\n")}\n`
  );
}
