import { z } from "zod";
import type { GateViolation } from "../gates.js";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "../runner.js";
import {
  evidenceItems,
  findLastStructuredOutput,
} from "../structured-output.js";

interface LearnOptions {
  agentAdapter?: AgentAdapter;
  contextFile: string | null;
  harness: Harness;
  outcome: "PASS" | "FAIL";
  taskDescription: string;
  testOutput: string;
  ticketId?: string | null;
  violations: GateViolation[];
  worktreePath: string;
}

export interface LearnResult {
  evidence: string[];
  memoryDisabled: boolean;
  qdrant: {
    attempted: boolean;
    required: boolean;
    succeeded: boolean;
  };
}

const learnReportSchema = z.object({
  evidence: z.unknown().optional(),
  qdrant: z.object({
    attempted: z.boolean(),
    succeeded: z.boolean(),
  }),
});

function memoryDisabled(): boolean {
  return (
    process.env.PIPELINE_MEMORY === "disabled" ||
    process.env.PIPELINE_DISABLE_MEMORY === "1"
  );
}

function parseLearnReport(
  stdout: string
): z.infer<typeof learnReportSchema> | null {
  return findLastStructuredOutput(
    stdout,
    learnReportSchema,
    "$..[?(@.qdrant)]"
  );
}

export async function runLearn(opts: LearnOptions): Promise<LearnResult> {
  const {
    agentAdapter = subprocessAgentAdapter,
    contextFile,
    harness,
    outcome,
    taskDescription,
    testOutput,
    ticketId = null,
    violations,
    worktreePath,
  } = opts;
  const disabled = memoryDisabled();
  if (disabled) {
    return {
      evidence: ["memory disabled for this run"],
      memoryDisabled: true,
      qdrant: { attempted: false, required: false, succeeded: false },
    };
  }

  const learnPrompt = [
    "You are the LEARN phase for the oisin pipeline.",
    "Do not write local knowledge or markdown files.",
    "Extract one durable lesson from this run and call qdrant-store with metadata including phase=learn and the run outcome.",
    'After the tool call, output ONLY JSON: {"qdrant":{"attempted":true,"succeeded":true},"evidence":["stored lesson id or tool evidence"]}.',
    "",
    `Task: ${taskDescription}`,
    `Outcome before LEARN: ${outcome}`,
    `Violations: ${JSON.stringify(violations)}`,
    `Test output: ${testOutput.slice(0, 2000)}`,
  ].join("\n");

  const result = await agentAdapter.run({
    contextFile,
    harness,
    prompt: learnPrompt,
    role: "researcher",
    ticketId,
    worktreePath,
  });
  const report = parseLearnReport(result.stdout);
  if (!report) {
    return {
      evidence: ["LEARN did not return a parseable qdrant report"],
      memoryDisabled: false,
      qdrant: { attempted: false, required: true, succeeded: false },
    };
  }

  return {
    evidence: evidenceItems(report.evidence),
    memoryDisabled: false,
    qdrant: {
      attempted: report.qdrant.attempted,
      required: true,
      succeeded: report.qdrant.succeeded,
    },
  };
}
