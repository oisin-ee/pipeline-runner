import { readFile } from "node:fs/promises";
import { execa } from "execa";

import { resolveProfileForPhase } from "./config.js";

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
  /** Optional ticket id used by the resolver for frontmatter override lookup. */
  ticketId?: string | null;
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

/**
 * Per-harness argv shape (excluding the leading harness binary name and
 * any stdin/stdio plumbing). Used by `execaProfile` to build the args after
 * the profile launcher's own positional `<harness>` argument.
 */
function harnessArgv(
  harness: Exclude<Harness, "pi">,
  prompt: string,
  worktreePath: string,
  contextFile: string | null
): string[] {
  switch (harness) {
    case "claude":
      // Claude's --print mode just takes one big prompt; we prepend the
      // context the way spawnClaude used to.
      return ["--print", "-p", prompt];
    case "codex":
      // --sandbox workspace-write: codex's default sandbox is read-only, which
      // makes the test-writer / code-writer / learn phases unable to produce
      // file artifacts. workspace-write scopes writes to the worktree.
      return [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        prompt,
        "-C",
        worktreePath,
      ];
    case "opencode":
      return contextFile
        ? [
            "run",
            "--format",
            "json",
            "--dir",
            worktreePath,
            prompt,
            "--file",
            contextFile,
          ]
        : ["run", "--format", "json", "--dir", worktreePath, prompt];
    default: {
      const _exhaustive: never = harness;
      throw new Error(
        `Unhandled harness in harnessArgv: ${String(_exhaustive)}`
      );
    }
  }
}

/**
 * Spawn a profile launcher (`<profile> <harness> [args...]`) in the given
 * worktree. The launcher applies the profile's rules/MCP/skills/subagents
 * to cwd via `rulesync generate`, then execs the harness.
 *
 * Special-cases `pi` to preserve its stdin RPC protocol: the runner pipes
 * stdin to the launcher, which inherits stdio to pi.
 */
async function execaProfile(
  profile: string,
  harness: Harness,
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  if (harness === "pi") {
    return execaProfilePi(profile, prompt, contextFile, worktreePath);
  }

  // Claude reads stdin as part of `--print` only when piped; we prepend the
  // loaded context to the prompt string instead (matches the prior spawnClaude
  // semantics).
  let effectivePrompt = prompt;
  if (harness === "claude") {
    const context = await loadContext(contextFile);
    effectivePrompt = context ? `${context}\n${prompt}` : prompt;
  }

  // Codex's `exec` reads context via stdin (matches the prior spawnCodex).
  const input =
    harness === "codex" && contextFile
      ? await loadContext(contextFile)
      : undefined;

  const argv = harnessArgv(harness, effectivePrompt, worktreePath, contextFile);
  const result = await execa(profile, [harness, ...argv], {
    cwd: worktreePath,
    ...(input === undefined ? {} : { input }),
  });
  return { stdout: result.stdout, exitCode: result.exitCode ?? 0 };
}

/**
 * Pi-specific path. The launcher's `stdio: 'inherit'` causes pi to inherit
 * the launcher's stdin; we pipe from this process into the launcher.
 */
async function execaProfilePi(
  profile: string,
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<AgentResult> {
  const subprocess = execa(profile, ["pi", "--mode", "rpc", "--no-session"], {
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

/**
 * Hard adapter (strict mode): resolves a phase-specific specialized profile
 * via `.pipeline/config.toml` + ticket frontmatter, then exec's it.
 *
 * Each phase runs in its own subprocess with its own profile applied to
 * the worktree (rules + MCP + skills + subagents). The Mastra workflow
 * enforces gate semantics between phases.
 */
export const hardAgentAdapter: AgentAdapter = {
  run({
    role,
    harness,
    prompt,
    contextFile,
    worktreePath,
    ticketId,
  }: AgentRunRequest): Promise<AgentResult> {
    const profile = resolveProfileForPhase(
      role,
      ticketId ?? null,
      worktreePath
    );
    return execaProfile(profile, harness, prompt, contextFile, worktreePath);
  },
};

/**
 * Back-compat shim: existing step files import `spawnAgent` to invoke the
 * runner. Now goes through `hardAgentAdapter`. The `role` argument is no
 * longer ignored.
 */
export function spawnAgent(
  harness: Harness,
  role: AgentRole,
  prompt: string,
  contextFile: string | null,
  worktreePath: string,
  ticketId: string | null = null
): Promise<AgentResult> {
  return hardAgentAdapter.run({
    contextFile,
    harness,
    prompt,
    role,
    worktreePath,
    ticketId,
  });
}

/**
 * Alias retained for callers that import `subprocessAgentAdapter`. The
 * underlying behavior changed (now goes through a profile launcher per
 * phase rather than raw harness binaries), but the contract — Mastra
 * agent adapter — is the same shape.
 */
export const subprocessAgentAdapter: AgentAdapter = hardAgentAdapter;
