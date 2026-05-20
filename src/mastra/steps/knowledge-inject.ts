import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readMdFiles(dir: string, limit?: number): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = limit ? entries.slice(-limit) : entries;
  return files.flatMap((e) => {
    try {
      return [readFileSync(join(dir, e.name), "utf-8")];
    } catch {
      return [];
    }
  });
}

export function buildKnowledgeContext(worktreePath: string): string {
  const rulesDir = join(worktreePath, "rules");
  const knowledgeDir = join(worktreePath, ".pipeline", "knowledge");

  const rules = readMdFiles(rulesDir);
  const knowledge = readMdFiles(knowledgeDir, 3);

  const parts = [...rules, ...knowledge].filter(Boolean);
  return parts.join("\n\n---\n\n");
}
