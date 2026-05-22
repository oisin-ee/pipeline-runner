import type { GateViolation } from "../gates.js";
import { runJscpd, runStyleGates } from "../gates.js";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "../runner.js";

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

// Matches every balanced `{...}` block in the input (greedy nesting handled
// by JSON.parse in `findVerdictJson`). We use `g` to enumerate matches and
// then scan right-to-left so the LAST `{...}` containing a `"verdict"` key
// wins — harness JSONL streams (codex/opencode/pi) emit many protocol events
// where the FIRST `{...}` is e.g. `{"type":"step_start",...}`, never the
// verdict. Using the first match is what produced false-FAIL verdicts.
const JSON_OBJECT_PATTERN = /\{[\s\S]*?\}/g;

/**
 * Find the rightmost JSON object in `stdout` that has a `verdict` key.
 * Returns the parsed object, or `null` if none found. Per-line JSON.parse
 * (rather than balanced-brace parsing) is sufficient because the verifier
 * is instructed to output a single one-line JSON object — any multi-line
 * wrapper around it (e.g. codex's `{"type":"item.completed","item":{...}}`
 * event) is handled by the `verdict`-key filter.
 */
function findVerdictJson(stdout: string): {
  verdict?: string;
  evidence?: string[];
} | null {
  const matches = stdout.match(JSON_OBJECT_PATTERN) ?? [];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i]);
      if (parsed && typeof parsed === "object" && "verdict" in parsed) {
        return parsed as { verdict?: string; evidence?: string[] };
      }
    } catch {
      // skip non-JSON candidate
    }
  }
  return null;
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
      verdict: parsed.verdict === "PASS" ? "PASS" : "FAIL",
      evidence: parsed.evidence ?? [],
    };
  }
  // If verifier output contains "PASS" keyword (e.g. wrapped in prose),
  // treat as pass.
  if (
    result.stdout.toUpperCase().includes('"PASS"') ||
    result.stdout.includes("verdict: PASS")
  ) {
    return { verdict: "PASS", evidence: [] };
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

  const [jscpdResult, styleResult, llmResult] = await Promise.all([
    runJscpd(worktreePath),
    Promise.resolve(runStyleGates(worktreePath)),
    runLlmVerify(
      harness,
      prompt,
      contextFile,
      worktreePath,
      ticketId,
      agentAdapter
    ),
  ]);

  const violations = [...jscpdResult.violations, ...styleResult.violations];

  return {
    passed: violations.length === 0 && llmResult.verdict === "PASS",
    violations,
    llmVerdict: llmResult.verdict,
    llmEvidence: llmResult.evidence,
  };
}
