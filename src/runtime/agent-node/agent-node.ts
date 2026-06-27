import { Effect } from "effect";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { EXIT_INFRA } from "../exit-codes";
import type { NodeHandoff } from "../handoff";
import {
  type AgentNodeRuntimeService,
  AgentNodeRuntimeServiceLive,
} from "../services/agent-node-runtime-service";
import { maybeDeriveHandoffEffect } from "./handoff-finalization";
import {
  decideNodeModel,
  fallbackNote,
  modelLabel,
  type NodeModelDecision,
} from "./model-selection";
import {
  finalizeAgentOutputEffect,
  normalizeAgentOutput,
} from "./output-finalization";
import { renderAgentPromptEffect } from "./prompt-rendering";
import {
  type ModelAttemptOutcome,
  runModelAttemptEffect,
} from "./session-execution";

export function executeAgentNode(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Promise<NodeAttemptResult> {
  const program = executeAgentNodeEffect(node, context, attempt);
  return Effect.runPromise(
    Effect.provide(program, AgentNodeRuntimeServiceLive)
  );
}

function executeAgentNodeEffect(
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number
): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    if (!node.profile) {
      return missingProfileResult(node.id);
    }
    const prompt = yield* renderAgentPromptEffect(node, context);
    const decision = decideNodeModel(
      prompt,
      node,
      context.config.token_budget,
      context.availableModels
    );
    if (decision.overBudget) {
      return overBudgetResult(node, decision);
    }
    return yield* runSelectedModelEffect({
      attempt,
      context,
      decision,
      node,
      profileId: node.profile,
      prompt,
    });
  });
}

function missingProfileResult(nodeId: string): NodeAttemptResult {
  return {
    evidence: [`node '${nodeId}' has no profile`],
    exitCode: 1,
    output: "",
  };
}

function overBudgetResult(
  node: PlannedWorkflowNode,
  decision: NodeModelDecision
): NodeAttemptResult {
  return {
    evidence: [
      `agent boundary node=${node.id} profile=${node.profile}`,
      `over token budget: ${decision.reason}`,
      ...skippedModelEvidence(decision),
    ],
    exitCode: 1,
    output: "",
  };
}

function runSelectedModelEffect(inputs: {
  attempt: number;
  context: RuntimeContext;
  decision: NodeModelDecision;
  node: PlannedWorkflowNode;
  profileId: string;
  prompt: string;
}): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const fallbackEvidence: string[] = [];
    for (let index = 0; index < inputs.decision.candidates.length; index += 1) {
      const model = inputs.decision.candidates[index];
      const outcome = yield* runModelAttemptEffect({
        attempt: inputs.attempt,
        context: inputs.context,
        model,
        node: inputs.node,
        profileId: inputs.profileId,
        prompt: inputs.prompt,
      });
      if (shouldUseAttemptResult(outcome, inputs.decision, index)) {
        return yield* buildAgentAttemptResultEffect({
          ...inputs,
          fallbackEvidence,
          model,
          outcome,
        });
      }
      fallbackEvidence.push(
        fallbackNote(
          model,
          inputs.decision.candidates[index + 1],
          outcome.result
        )
      );
    }
    return missingModelResult(inputs.node.id);
  });
}

function shouldUseAttemptResult(
  outcome: ModelAttemptOutcome,
  decision: NodeModelDecision,
  index: number
): boolean {
  const lastCandidate = index === decision.candidates.length - 1;
  return outcome.result.exitCode !== EXIT_INFRA || lastCandidate;
}

function missingModelResult(nodeId: string): NodeAttemptResult {
  return {
    evidence: [`node '${nodeId}' has no model candidate`],
    exitCode: 1,
    output: "",
  };
}

function buildAgentAttemptResultEffect(inputs: {
  attempt: number;
  context: RuntimeContext;
  decision: NodeModelDecision;
  fallbackEvidence: string[];
  model: string | undefined;
  node: PlannedWorkflowNode;
  outcome: ModelAttemptOutcome;
  profileId: string;
}): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const { plan, result } = inputs.outcome;
    const normalized = normalizeAgentOutput(plan, result.stdout);
    const finalized = yield* finalizeAgentOutputEffect({
      attempt: inputs.attempt,
      context: inputs.context,
      node: inputs.node,
      normalized,
      plan,
      result,
    });
    const handoff = yield* maybeDeriveHandoffEffect(
      inputs.context,
      inputs.node,
      finalized.output,
      inputs.attempt
    );
    const attemptResult: NodeAttemptResult = {
      evidence: [
        `agent boundary node=${inputs.node.id} profile=${inputs.profileId} runner=${plan.runnerId}`,
        `estimated context tokens: ${inputs.decision.estimatedTokens}`,
        `model selection: ${modelLabel(inputs.model)} (${inputs.decision.reason})`,
        ...skippedModelEvidence(inputs.decision),
        ...inputs.fallbackEvidence,
        ...finalized.evidence,
        ...stderrEvidence(result.stderr),
        ...timeoutEvidence(result.timedOut),
      ],
      exitCode: result.exitCode,
      output: finalized.output,
      timedOut: result.timedOut,
    };
    return withOptionalHandoff(attemptResult, handoff);
  });
}

function skippedModelEvidence(decision: NodeModelDecision): string[] {
  return decision.skipped.length
    ? [`model fallbacks skipped: ${decision.skipped.join(", ")}`]
    : [];
}

function stderrEvidence(stderr: string | undefined): string[] {
  return stderr ? [`stderr: ${stderr}`] : [];
}

function timeoutEvidence(timedOut: boolean | undefined): string[] {
  return timedOut ? ["agent timed out"] : [];
}

function withOptionalHandoff(
  result: NodeAttemptResult,
  handoff: NodeHandoff | undefined
): NodeAttemptResult {
  return handoff ? { ...result, handoff } : result;
}
