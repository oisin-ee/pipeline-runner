import { z } from "zod";
import type { GateViolation } from "../gates.js";
import { runJscpd } from "../gates.js";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "../runner.js";
import {
  evidenceItems,
  findLastStructuredOutput,
} from "../structured-output.js";

interface VerifyOptions {
  agentAdapter?: AgentAdapter;
  contextFile: string | null;
  harness: Harness;
  prompt: string;
  ticketId?: string | null;
  worktreePath: string;
}

interface VerifyResult {
  llmEvidence: string[];
  llmVerdict: "PASS" | "FAIL";
  passed: boolean;
  violations: GateViolation[];
}

const verdictSchema = z.object({
  evidence: z.unknown().optional(),
  verdict: z.enum(["PASS", "FAIL"]),
});

function findVerdictJson(stdout: string): z.infer<typeof verdictSchema> | null {
  return findLastStructuredOutput(stdout, verdictSchema, "$..[?(@.verdict)]");
}

async function runLlmVerify(
  harness: Harness,
  prompt: string,
  contextFile: string | null,
  worktreePath: string,
  ticketId: string | null,
  agentAdapter: AgentAdapter
): Promise<{ verdict: "PASS" | "FAIL"; evidence: string[] }> {
  const verifyPrompt = [
    "You are a code verifier. Review the implementation and output ONLY valid JSON.",
    'Output format: {"verdict": "PASS", "evidence": []} or {"verdict": "FAIL", "evidence": ["reason"]}',
    "Check: (1) Implementation matches the task. (2) No obvious bugs. (3) Code is clean.",
    "",
    `Task: ${prompt}`,
  ].join("\n");
  const result = await agentAdapter
    .run({
      contextFile,
      harness,
      prompt: verifyPrompt,
      role: "verifier",
      ticketId,
      worktreePath,
    })
    .catch(() => ({ stdout: "", exitCode: 1 }));
  const parsed = findVerdictJson(result.stdout);
  if (parsed) {
    return {
      verdict: parsed.verdict,
      evidence: evidenceItems(parsed.evidence),
    };
  }
  return { verdict: "FAIL", evidence: ["unparseable verifier output"] };
}

export async function runVerify(opts: VerifyOptions): Promise<VerifyResult> {
  const {
    worktreePath,
    prompt,
    contextFile,
    harness,
    ticketId = null,
    agentAdapter = subprocessAgentAdapter,
  } = opts;

  const [jscpdResult, llmResult] = await Promise.all([
    runJscpd(worktreePath),
    runLlmVerify(
      harness,
      prompt,
      contextFile,
      worktreePath,
      ticketId,
      agentAdapter
    ),
  ]);

  const violations = jscpdResult.violations;

  return {
    passed: violations.length === 0 && llmResult.verdict === "PASS",
    violations,
    llmVerdict: llmResult.verdict,
    llmEvidence: llmResult.evidence,
  };
}
