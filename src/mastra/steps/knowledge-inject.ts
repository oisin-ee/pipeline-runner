import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const KNOWLEDGE_CONTEXT_FILE = "knowledge-context.md";
export const MAX_KNOWLEDGE_CONTEXT_CHARS = 64_000;

interface KnowledgeContextOptions {
  maxChars?: number;
}

interface KnowledgeContextFile {
  context: string;
  contextFile: string;
}

interface MarkdownFile {
  content: string;
  name: string;
}

function readMdFiles(dir: string, limit?: number): MarkdownFile[] {
  if (!existsSync(dir)) {
    return [];
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const markdownEntries = entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = limit ? markdownEntries.slice(-limit) : markdownEntries;
  return files.flatMap((e) => {
    try {
      return [
        { content: readFileSync(join(dir, e.name), "utf-8"), name: e.name },
      ];
    } catch {
      return [];
    }
  });
}

function renderSection(title: string, files: MarkdownFile[]): string {
  if (files.length === 0) {
    return "";
  }

  const renderedFiles = files.map(
    (file) => `## ${file.name}\n\n${file.content.trim()}`
  );
  return [`# ${title}`, ...renderedFiles].join("\n\n");
}

function truncateContext(context: string, maxChars: number): string {
  if (context.length <= maxChars) {
    return context;
  }

  const marker =
    "\n\n---\n\n[Knowledge context truncated: preserved the beginning and most recent end of context.]\n\n---\n\n";
  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars);
  }

  const remaining = maxChars - marker.length;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  return `${context.slice(0, headLength)}${marker}${context.slice(-tailLength)}`;
}

export function buildKnowledgeContext(
  worktreePath: string,
  options: KnowledgeContextOptions = {}
): string {
  const rulesDir = join(worktreePath, "rules");
  const knowledgeDir = join(worktreePath, ".pipeline", "knowledge");

  const rules = readMdFiles(rulesDir);
  const knowledge = readMdFiles(knowledgeDir, 3);
  const maxChars = options.maxChars ?? MAX_KNOWLEDGE_CONTEXT_CHARS;

  const parts = [
    renderSection("Current Rules", rules),
    renderSection("Recent Learned Knowledge", knowledge),
  ].filter(Boolean);

  return truncateContext(parts.join("\n\n---\n\n"), maxChars);
}

export async function writeKnowledgeContextFile(
  worktreePath: string,
  options: KnowledgeContextOptions = {}
): Promise<KnowledgeContextFile> {
  const pipelineDir = join(worktreePath, ".pipeline");
  const contextFile = join(pipelineDir, KNOWLEDGE_CONTEXT_FILE);
  const context = buildKnowledgeContext(worktreePath, options);

  await mkdir(pipelineDir, { recursive: true });
  await writeFile(contextFile, context);

  return { context, contextFile };
}
