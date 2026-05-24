import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { runGreen } from "../steps/green.js";
import { writeKnowledgeContextFile } from "../steps/knowledge-inject.js";
import { runLearn } from "../steps/learn.js";
import { runRed } from "../steps/red.js";
import { runResearch } from "../steps/research.js";
import { runVerify } from "../steps/verify.js";

const pipelineInput = z.object({
  task: z.string(),
  harness: z.enum(["claude", "codex", "opencode", "pi"]),
  worktreePath: z.string(),
});

const withContext = pipelineInput.extend({
  context: z.string(),
  contextFile: z.string(),
});
const withResearch = withContext.extend({ researchOutput: z.string() });
const withRed = withResearch.extend({
  redGatePassed: z.boolean(),
  redGateReason: z.string(),
  redTestOutput: z.string(),
  failingTests: z.array(z.string()),
});
const withGreen = withRed.extend({
  greenGatePassed: z.boolean(),
  testOutput: z.string(),
  typecheckOutput: z.string(),
});
const withVerify = withGreen.extend({
  verifyPassed: z.boolean(),
  llmVerdict: z.enum(["PASS", "FAIL"]),
  llmEvidence: z.array(z.string()),
  violations: z.array(
    z.object({
      file: z.string(),
      message: z.string(),
      line: z.number().optional(),
    })
  ),
});

const gateFailureSchema = z.object({
  gate: z.enum(["RESEARCH", "RED", "GREEN", "VERIFY", "LEARN"]),
  reason: z.string(),
  evidence: z.array(z.string()),
});

const pipelineOutput = z.object({
  outcome: z.enum(["PASS", "FAIL"]),
  failureDetails: z.array(gateFailureSchema),
});

type GateFailure = z.infer<typeof gateFailureSchema>;
type PipelineOutput = z.infer<typeof pipelineOutput>;
type PipelineEvaluationInput = z.infer<typeof withVerify>;

function compactEvidence(items: Array<string | undefined>): string[] {
  return items
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
}

function gateEvidence(
  items: Array<string | undefined>,
  fallback: string
): string[] {
  const evidence = compactEvidence(items);
  return evidence.length > 0 ? evidence : [fallback];
}

export function evaluatePipelineOutcome(
  inputData: PipelineEvaluationInput
): PipelineOutput {
  const failureDetails: GateFailure[] = [];

  if (!inputData.redGatePassed) {
    failureDetails.push({
      gate: "RED",
      reason: inputData.redGateReason,
      evidence: gateEvidence(
        [
          inputData.redTestOutput,
          inputData.failingTests.length > 0
            ? `Failing tests: ${inputData.failingTests.join(", ")}`
            : undefined,
        ],
        "RED gate failed without captured test output"
      ),
    });
  }

  if (!inputData.greenGatePassed) {
    failureDetails.push({
      gate: "GREEN",
      reason: "GREEN gate failed: tests or typecheck did not pass",
      evidence: gateEvidence(
        [
          inputData.failingTests.length > 0
            ? `Failing tests: ${inputData.failingTests.join(", ")}`
            : undefined,
          inputData.testOutput,
          inputData.typecheckOutput,
        ],
        "GREEN gate failed without captured test or typecheck output"
      ),
    });
  }

  if (!inputData.verifyPassed) {
    failureDetails.push({
      gate: "VERIFY",
      reason: "VERIFY gate failed: verification checks did not pass",
      evidence: gateEvidence(
        [
          ...inputData.violations.map((violation) => {
            const location =
              violation.line === undefined
                ? violation.file
                : `${violation.file}:${violation.line}`;
            return `${location}: ${violation.message}`;
          }),
          inputData.llmVerdict === "FAIL" ? "LLM verifier verdict: FAIL" : "",
          ...inputData.llmEvidence,
        ],
        "VERIFY gate failed without captured verification evidence"
      ),
    });
  }

  return {
    outcome: failureDetails.length === 0 ? "PASS" : "FAIL",
    failureDetails,
  };
}

const knowledgeInjectStep = createStep({
  id: "knowledge-inject",
  inputSchema: pipelineInput,
  outputSchema: withContext,
  execute: async ({ inputData }) => {
    const { context, contextFile } = await writeKnowledgeContextFile(
      inputData.worktreePath
    );
    return { ...inputData, context, contextFile };
  },
});

const researchStep = createStep({
  id: "research",
  inputSchema: withContext,
  outputSchema: withResearch,
  execute: async ({ inputData }) => {
    const result = await runResearch({
      worktreePath: inputData.worktreePath,
      prompt: inputData.task,
      contextFile: inputData.contextFile,
      harness: inputData.harness,
    });
    return { ...inputData, researchOutput: result.output };
  },
});

const redStep = createStep({
  id: "red",
  inputSchema: withResearch,
  outputSchema: withRed,
  execute: async ({ inputData }) => {
    const result = await runRed({
      worktreePath: inputData.worktreePath,
      prompt: inputData.task,
      contextFile: inputData.contextFile,
      harness: inputData.harness,
    });
    return {
      ...inputData,
      redGatePassed: result.redGatePassed,
      redGateReason: result.reason,
      redTestOutput: result.output,
      failingTests: result.failingTests,
    };
  },
});

const greenStep = createStep({
  id: "green",
  inputSchema: withRed,
  outputSchema: withGreen,
  execute: async ({ inputData }) => {
    const result = await runGreen({
      worktreePath: inputData.worktreePath,
      prompt: inputData.task,
      contextFile: inputData.contextFile,
      harness: inputData.harness,
    });
    return {
      ...inputData,
      greenGatePassed: result.greenGatePassed,
      failingTests: result.failingTests,
      testOutput: result.testOutput,
      typecheckOutput: result.typecheckOutput,
    };
  },
});

const verifyStep = createStep({
  id: "verify",
  inputSchema: withGreen,
  outputSchema: withVerify,
  execute: async ({ inputData }) => {
    const result = await runVerify({
      worktreePath: inputData.worktreePath,
      prompt: inputData.task,
      contextFile: inputData.contextFile,
      harness: inputData.harness,
    });
    return {
      ...inputData,
      verifyPassed: result.passed,
      llmVerdict: result.llmVerdict,
      llmEvidence: result.llmEvidence,
      violations: result.violations,
    };
  },
});

const learnStep = createStep({
  id: "learn",
  inputSchema: withVerify,
  outputSchema: pipelineOutput,
  execute: async ({ inputData }) => {
    const result = evaluatePipelineOutcome(inputData);
    const learn = await runLearn({
      contextFile: inputData.contextFile,
      harness: inputData.harness,
      worktreePath: inputData.worktreePath,
      taskDescription: inputData.task,
      outcome: result.outcome,
      violations: inputData.violations,
      testOutput: inputData.testOutput,
    });
    if (learn.qdrant.required && !learn.qdrant.succeeded) {
      return {
        outcome: "FAIL" as const,
        failureDetails: [
          ...result.failureDetails,
          {
            gate: "LEARN" as const,
            reason: "LEARN gate failed: qdrant-store did not succeed",
            evidence:
              learn.evidence.length > 0
                ? learn.evidence
                : ["qdrant-store was required but did not succeed"],
          },
        ],
      };
    }
    return result;
  },
});

export const pipelineWorkflow = createWorkflow({
  id: "ralph-loop",
  inputSchema: pipelineInput,
  outputSchema: pipelineOutput,
})
  .then(knowledgeInjectStep)
  .then(researchStep)
  .then(redStep)
  .then(greenStep)
  .then(verifyStep)
  .then(learnStep)
  .commit();
