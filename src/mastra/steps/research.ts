import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "../runner.js";

interface ResearchOptions {
  agentAdapter?: AgentAdapter;
  contextFile: string | null;
  harness: Harness;
  maxRetries?: number;
  prompt: string;
  ticketId?: string | null;
  worktreePath: string;
}

interface ResearchResult {
  artifactPath: string;
  exitCode: number;
  findings: string[];
  output: string;
  reason?: string;
}

const researchArtifactSchema = z.object({
  ac: z.array(z.string().min(1)).min(1),
  findings: z.array(z.string().min(1)).min(1),
});

const RESEARCH_BRIEF_IGNORE = [
  "node_modules/",
  ".opencode/",
  ".mastra/",
  "dist/",
  "build/",
  "coverage/",
  ".git/",
];
const MAX_BRIEF_FILES = 40;
const MAX_BRIEF_FILE_CHARS = 1200;
const MAX_RESEARCH_BRIEF_CHARS = 20_000;
const LINE_RE = /\r?\n/;

function redactDiagnostics(value: string): string {
  return value
    .replace(
      /(Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi,
      "$1[REDACTED]"
    )
    .replace(/(api[_-]?key[=:]\s*)[A-Za-z0-9._-]+/gi, "$1[REDACTED]");
}

function diagnosticOutput(result: {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
}): string {
  const sections = [
    `agent exitCode=${result.exitCode ?? 1}`,
    result.timedOut ? "agent timed out" : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
    result.stdout ? `stdout:\n${result.stdout}` : "",
  ].filter(Boolean);
  return redactDiagnostics(sections.join("\n\n")).slice(0, 4000);
}

async function readResearchArtifact(
  worktreePath: string
): Promise<{ ac: string[]; findings: string[] }> {
  const artifactPath = join(worktreePath, ".pipeline", "research.json");
  const raw = await readFile(artifactPath, "utf8");
  return researchArtifactSchema.parse(JSON.parse(raw));
}

async function buildResearchBrief(worktreePath: string): Promise<string> {
  let files: string[] = [];
  try {
    const stdout = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...RESEARCH_BRIEF_IGNORE.map((entry) => `:(exclude)${entry}`),
      ],
      {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    files = stdout.split(LINE_RE).filter(Boolean);
  } catch {
    files = [];
  }
  const sections: string[] = [];
  for (const file of files.sort().slice(0, MAX_BRIEF_FILES)) {
    try {
      const content = await readFile(join(worktreePath, file), "utf8");
      sections.push(
        `## ${file}\n\n${content.slice(0, MAX_BRIEF_FILE_CHARS)}${content.length > MAX_BRIEF_FILE_CHARS ? "\n...[truncated]" : ""}`
      );
    } catch {
      // Files can disappear while a harness is working; omit them from the brief.
    }
  }
  return sections.join("\n\n").slice(0, MAX_RESEARCH_BRIEF_CHARS);
}

export async function runResearch(
  opts: ResearchOptions
): Promise<ResearchResult> {
  const {
    worktreePath,
    prompt,
    contextFile,
    harness,
    ticketId = null,
    agentAdapter = subprocessAgentAdapter,
    maxRetries = 2,
  } = opts;
  const artifactPath = join(worktreePath, ".pipeline", "research.json");
  const researchBrief = await buildResearchBrief(worktreePath);
  let lastResult: ResearchResult = {
    artifactPath,
    exitCode: 1,
    findings: [],
    output: "",
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const researchPrompt = [
      "You are a researcher. Use the repository brief below as the starting point.",
      "You may inspect additional first-party files when needed for the task.",
      "Do not traverse dependency, cache, build, coverage, or harness-generated directories such as node_modules, .opencode/node_modules, .mastra, dist, build, coverage, or .git.",
      "If memory is available, call qdrant-find once with the task description. If qdrant is slow or unavailable, continue without it.",
      "Write `.pipeline/research.json` as the required artifact with non-empty `findings` and `ac` string arrays.",
      "Do not finish until `.pipeline/research.json` exists and is valid JSON.",
      "",
      `Task to research: ${prompt}`,
      "",
      "Repository brief:",
      researchBrief ||
        "(no first-party files matched the bounded research patterns)",
    ].join("\n");
    const result = await agentAdapter
      .run({
        contextFile,
        harness,
        prompt: researchPrompt,
        role: "researcher",
        ticketId,
        worktreePath,
      })
      .catch(
        (err: {
          exitCode?: number;
          stderr?: string;
          stdout?: string;
          timedOut?: boolean;
        }) => ({
          stderr: err.stderr ?? "",
          stdout: err.stdout ?? "",
          exitCode: err.exitCode ?? 1,
          timedOut: Boolean(err.timedOut),
        })
      );
    lastResult = {
      artifactPath,
      exitCode: result.exitCode,
      findings: [],
      output: diagnosticOutput(result),
    };
    if (result.exitCode === 0 || result.timedOut) {
      break;
    }
  }

  try {
    const artifact = await readResearchArtifact(worktreePath);
    return {
      ...lastResult,
      exitCode: 0,
      findings: artifact.findings,
      output: JSON.stringify(artifact),
    };
  } catch (err) {
    return {
      ...lastResult,
      exitCode: 1,
      reason: `invalid research artifact: ${(err as Error).message}`,
    };
  }
}
