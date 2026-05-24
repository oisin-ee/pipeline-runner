import type { PipelineLifecycleResult } from "./backlog.js";
import {
  type AgentAdapter,
  type Harness,
  subprocessAgentAdapter,
} from "./runner.js";
import { runGreen } from "./steps/green.js";
import { writeKnowledgeContextFile } from "./steps/knowledge-inject.js";
import { runLearn } from "./steps/learn.js";
import { runRed } from "./steps/red.js";
import { runResearch } from "./steps/research.js";
import { runVerify } from "./steps/verify.js";
import { evaluatePipelineOutcome } from "./workflows/pipeline.js";

export type PipelinePhase = "research" | "red" | "green" | "verify" | "learn";

export interface PipelinePhaseReporter {
  completed?(phase: PipelinePhase): Promise<void> | void;
  started?(phase: PipelinePhase): Promise<void> | void;
}

export interface PipelinePrimitiveInput {
  harness: Harness;
  task: string;
  /**
   * Optional ticket id (Backlog.md style, e.g. "PIPE-42") parsed from the
   * task string. Used by the strict-mode resolver to look up phase-profile
   * overrides in the parent ticket's frontmatter.
   */
  ticketId?: string | null;
  worktreePath: string;
}

export interface PipelinePrimitiveAdapters {
  agentAdapter?: AgentAdapter;
  phaseReporter?: PipelinePhaseReporter;
}

async function report(
  reporter: PipelinePhaseReporter | undefined,
  event: "started" | "completed",
  phase: PipelinePhase
): Promise<void> {
  await reporter?.[event]?.(phase);
}

export async function runPipelinePrimitive(
  input: PipelinePrimitiveInput,
  adapters: PipelinePrimitiveAdapters = {}
): Promise<PipelineLifecycleResult> {
  const agentAdapter = adapters.agentAdapter ?? subprocessAgentAdapter;
  const { harness, task, worktreePath, ticketId = null } = input;

  await report(adapters.phaseReporter, "started", "research");
  const { contextFile } = await writeKnowledgeContextFile(worktreePath);
  const research = await runResearch({
    agentAdapter,
    contextFile,
    harness,
    prompt: task,
    ticketId,
    worktreePath,
  });
  await report(adapters.phaseReporter, "completed", "research");
  if (research.exitCode !== 0) {
    return {
      outcome: "FAIL",
      failureDetails: [
        {
          gate: "RESEARCH",
          reason: research.reason ?? "RESEARCH gate failed",
          evidence: [research.output || research.artifactPath].filter(Boolean),
        },
      ],
    };
  }

  await report(adapters.phaseReporter, "started", "red");
  const red = await runRed({
    agentAdapter,
    contextFile,
    harness,
    prompt: task,
    ticketId,
    worktreePath,
  });
  await report(adapters.phaseReporter, "completed", "red");

  await report(adapters.phaseReporter, "started", "green");
  const green = await runGreen({
    agentAdapter,
    contextFile,
    harness,
    prompt: task,
    ticketId,
    worktreePath,
  });
  await report(adapters.phaseReporter, "completed", "green");

  await report(adapters.phaseReporter, "started", "verify");
  const verify = await runVerify({
    agentAdapter,
    contextFile,
    harness,
    prompt: task,
    ticketId,
    worktreePath,
  });
  await report(adapters.phaseReporter, "completed", "verify");

  const result = evaluatePipelineOutcome({
    context: "",
    contextFile,
    failingTests:
      green.failingTests.length > 0 ? green.failingTests : red.failingTests,
    greenGatePassed: green.greenGatePassed,
    harness,
    llmEvidence: verify.llmEvidence,
    llmVerdict: verify.llmVerdict,
    redGatePassed: red.redGatePassed,
    redGateReason: red.reason,
    redTestOutput: red.output,
    researchOutput: research.output,
    task,
    testOutput: green.testOutput,
    typecheckOutput: green.typecheckOutput,
    verifyPassed: verify.passed,
    violations: verify.violations,
    worktreePath,
  });

  await report(adapters.phaseReporter, "started", "learn");
  const learn = await runLearn({
    agentAdapter,
    contextFile,
    harness,
    outcome: result.outcome,
    taskDescription: task,
    testOutput: green.testOutput,
    ticketId,
    violations: verify.violations,
    worktreePath,
  });
  await report(adapters.phaseReporter, "completed", "learn");

  if (learn.qdrant.required && !learn.qdrant.succeeded) {
    return {
      outcome: "FAIL",
      failureDetails: [
        ...result.failureDetails,
        {
          gate: "LEARN",
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
}
