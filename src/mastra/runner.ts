import { readFile } from "node:fs/promises";
import { execa } from "execa";

export type Harness = "claude" | "codex" | "opencode" | "pi";
export type AgentRole =
  | "researcher"
  | "test-writer"
  | "code-writer"
  | "verifier";

export interface AgentResult {
  exitCode: number;
  stdout: string;
}

export interface AgentRunRequest {
  contextFile: string | null;
  harness: Harness;
  prompt: string;
  role: AgentRole;
  worktreePath: string;
}

export interface AgentAdapter {
  run(request: AgentRunRequest): Promise<AgentResult>;
}

async function loadContext(contextFile: string | null): Promise<string> {
  if (!contextFile) {
    return "";
  }
  return await readFile(contextFile, "utf8");
}

async function spawnClaude(
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  const context = await loadContext(contextFile);
  const fullPrompt = context ? `${context}\n${prompt}` : prompt;
  const result = await execa("claude", ["--print", "-p", fullPrompt], {
    cwd: worktreePath,
  });
  return { stdout: result.stdout, exitCode: result.exitCode ?? 0 };
}

async function spawnCodex(
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  const input = await loadContext(contextFile);
  const result = await execa(
    "codex",
    ["exec", "--json", prompt, "-C", worktreePath],
    { input }
  );
  return { stdout: result.stdout, exitCode: result.exitCode ?? 0 };
}

async function spawnOpencode(
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  const args = ["run", "--format", "json", "--dir", worktreePath, prompt];
  if (contextFile) {
    args.push("--file", contextFile);
  }
  const result = await execa("opencode", args);
  return { stdout: result.stdout, exitCode: result.exitCode ?? 0 };
}

async function spawnPi(
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  const subprocess = execa("pi", ["--mode", "rpc", "--no-session"], {
    cwd: worktreePath,
    stdin: "pipe",
  });

  if (contextFile) {
    subprocess.stdin.write(
      `${JSON.stringify({ type: "bash", command: `cat ${contextFile}` })}\n`
    );
  }
  subprocess.stdin.write(
    `${JSON.stringify({ type: "prompt", message: prompt })}\n`
  );

  const lines: string[] = [];
  for await (const line of subprocess.stdout) {
    const lineStr = typeof line === "string" ? line : String(line);
    lines.push(lineStr);
    try {
      const parsed = JSON.parse(lineStr);
      if (parsed.type === "agent_end") {
        subprocess.stdin.end();
        break;
      }
    } catch {
      // non-JSON line, continue
    }
  }

  const awaited = await subprocess;
  return { stdout: lines.join("\n"), exitCode: awaited.exitCode ?? 0 };
}

export function spawnAgent(
  harness: Harness,
  _role: AgentRole,
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  return subprocessAgentAdapter.run({
    contextFile,
    harness,
    prompt,
    role: _role,
    worktreePath,
  });
}

export const subprocessAgentAdapter: AgentAdapter = {
  run({
    contextFile,
    harness,
    prompt,
    worktreePath,
  }: AgentRunRequest): Promise<AgentResult> {
    switch (harness) {
      case "claude":
        return spawnClaude(prompt, contextFile, worktreePath);
      case "codex":
        return spawnCodex(prompt, contextFile, worktreePath);
      case "opencode":
        return spawnOpencode(prompt, contextFile, worktreePath);
      case "pi":
        return spawnPi(prompt, contextFile, worktreePath);
      default: {
        const _exhaustive: never = harness;
        throw new Error(`Unknown harness: ${String(_exhaustive)}`);
      }
    }
  },
};
