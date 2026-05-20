import type { GateViolation } from "../gates.js";
import { runJscpd, runStyleGates } from "../gates.js";
import type { Harness } from "../runner.js";
import { spawnAgent } from "../runner.js";

interface VerifyOptions {
  contextFile: string | null;
  harness: Harness;
  prompt: string;
  worktreePath: string;
}

interface VerifyResult {
  llmEvidence: string[];
  llmVerdict: "PASS" | "FAIL";
  passed: boolean;
  violations: GateViolation[];
}

interface LlmVerdict {
  evidence?: string[];
  verdict?: string;
}

async function runLlmVerify(
  harness: Harness,
  prompt: string,
  contextFile: string | null,
  worktreePath: string
): Promise<{ verdict: "PASS" | "FAIL"; evidence: string[] }> {
  const verifyPrompt = [
    "You are a code verifier. Review the implementation and output ONLY valid JSON.",
    'Output format: {"verdict": "PASS", "evidence": []} or {"verdict": "FAIL", "evidence": ["reason"]}',
    "Check: (1) Implementation matches the task. (2) No obvious bugs. (3) Code is clean.",
    "",
    `Task: ${prompt}`,
  ].join("\n");
  const result = await spawnAgent(
    harness,
    "verifier",
    verifyPrompt,
    contextFile,
    worktreePath
  ).catch(() => ({ stdout: "", exitCode: 1 }));
  try {
    const parsed = JSON.parse(result.stdout) as LlmVerdict;
    return {
      verdict: parsed.verdict === "PASS" ? "PASS" : "FAIL",
      evidence: parsed.evidence ?? [],
    };
  } catch {
    return { verdict: "FAIL", evidence: ["unparseable verifier output"] };
  }
}

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const { worktreePath, prompt, contextFile, harness } = opts;

  const [jscpdResult, styleResult, llmResult] = await Promise.all([
    runJscpd(worktreePath),
    Promise.resolve(runStyleGates(worktreePath)),
    runLlmVerify(harness, prompt, contextFile, worktreePath),
  ]);

  const violations = [...jscpdResult.violations, ...styleResult.violations];

  return {
    passed: violations.length === 0 && llmResult.verdict === "PASS",
    violations,
    llmVerdict: llmResult.verdict,
    llmEvidence: llmResult.evidence,
  };
}
