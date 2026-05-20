import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { runGreen } from "../steps/green.js";
import { buildKnowledgeContext } from "../steps/knowledge-inject.js";
import { runLearn } from "../steps/learn.js";
import { runRed } from "../steps/red.js";
import { runResearch } from "../steps/research.js";
import { runVerify } from "../steps/verify.js";

const pipelineInput = z.object({
  task: z.string(),
  harness: z.enum(["claude", "codex", "opencode", "pi"]),
  worktreePath: z.string(),
});

const withContext = pipelineInput.extend({ context: z.string() });
const withResearch = withContext.extend({ researchOutput: z.string() });
const withRed = withResearch.extend({
  redGatePassed: z.boolean(),
  failingTests: z.array(z.string()),
});
const withGreen = withRed.extend({
  greenGatePassed: z.boolean(),
  testOutput: z.string(),
});
const withVerify = withGreen.extend({
  verifyPassed: z.boolean(),
  violations: z.array(
    z.object({
      file: z.string(),
      message: z.string(),
      line: z.number().optional(),
    })
  ),
});

const knowledgeInjectStep = createStep({
  id: "knowledge-inject",
  inputSchema: pipelineInput,
  outputSchema: withContext,
  execute: async ({ inputData }) => ({
    ...inputData,
    context: buildKnowledgeContext(inputData.worktreePath),
  }),
});

const researchStep = createStep({
  id: "research",
  inputSchema: withContext,
  outputSchema: withResearch,
  execute: async ({ inputData }) => {
    const result = await runResearch({
      worktreePath: inputData.worktreePath,
      prompt: inputData.task,
      contextFile: null,
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
      contextFile: null,
      harness: inputData.harness,
    });
    return {
      ...inputData,
      redGatePassed: result.redGatePassed,
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
      contextFile: null,
      harness: inputData.harness,
    });
    return {
      ...inputData,
      greenGatePassed: result.greenGatePassed,
      testOutput: result.testOutput,
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
      contextFile: null,
      harness: inputData.harness,
    });
    return {
      ...inputData,
      verifyPassed: result.passed,
      violations: result.violations,
    };
  },
});

const learnStep = createStep({
  id: "learn",
  inputSchema: withVerify,
  outputSchema: z.object({ outcome: z.enum(["PASS", "FAIL"]) }),
  execute: async ({ inputData }) => {
    const outcome: "PASS" | "FAIL" =
      inputData.verifyPassed && inputData.greenGatePassed ? "PASS" : "FAIL";
    await runLearn({
      worktreePath: inputData.worktreePath,
      taskDescription: inputData.task,
      outcome,
      violations: inputData.violations,
      testOutput: inputData.testOutput,
    });
    return { outcome };
  },
});

export const pipelineWorkflow = createWorkflow({
  id: "ralph-loop",
  inputSchema: pipelineInput,
  outputSchema: z.object({ outcome: z.enum(["PASS", "FAIL"]) }),
})
  .then(knowledgeInjectStep)
  .then(researchStep)
  .then(redStep)
  .then(greenStep)
  .then(verifyStep)
  .then(learnStep)
  .commit();
