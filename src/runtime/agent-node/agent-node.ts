import { Effect, Option } from "effect";

import type { PlannedWorkflowNode } from "../../planning/compile";
import type { NodeAttemptResult, RuntimeContext } from "../contracts";
import { EXIT_INFRA } from "../exit-codes";
import type { NodeHandoff } from "../handoff";
import { AgentNodeRuntimeServiceLive } from "../services/agent-node-runtime-service";
import type { AgentNodeRuntimeService } from "../services/agent-node-runtime-service";
import { maybeDeriveHandoffEffect } from "./handoff-finalization";
import { decideNodeModel, fallbackNote, modelLabel } from "./model-selection";
import type { NodeModelDecision } from "./model-selection";
import { finalizeAgentOutputEffect, normalizeAgentOutput } from "./output-finalization";
import { renderAgentPromptEffect } from "./prompt-rendering";
import { runModelAttemptEffect } from "./session-execution";
import type { ModelAttemptOutcome } from "./session-execution";

const missingProfileResult = (nodeId: string): NodeAttemptResult => ({
  evidence: [`node '${nodeId}' has no profile`],
  exitCode: 1,
  output: "",
});

const shouldUseAttemptResult = (outcome: ModelAttemptOutcome, decision: NodeModelDecision, index: number): boolean => {
  const lastCandidate = index === decision.candidates.length - 1;
  return outcome.result.exitCode !== EXIT_INFRA || lastCandidate;
};

const missingModelResult = (nodeId: string): NodeAttemptResult => ({
  evidence: [`node '${nodeId}' has no model candidate`],
  exitCode: 1,
  output: "",
});

const skippedModelEvidence = (decision: NodeModelDecision): string[] =>
  decision.skipped.length > 0 ? [`model fallbacks skipped: ${decision.skipped.join(", ")}`] : [];

const overBudgetResult = (node: PlannedWorkflowNode, decision: NodeModelDecision): NodeAttemptResult => ({
  evidence: [
    `agent boundary node=${node.id} profile=${node.profile}`,
    `over token budget: ${decision.reason}`,
    ...skippedModelEvidence(decision),
  ],
  exitCode: 1,
  output: "",
});

const stderrEvidence = (stderr?: string): string[] =>
  stderr === undefined || stderr.length === 0 ? [] : [`stderr: ${stderr}`];

const timeoutEvidence = (timedOut?: boolean): string[] => (timedOut === true ? ["agent timed out"] : []);

const withOptionalHandoff = (result: NodeAttemptResult, handoff: Option.Option<NodeHandoff>): NodeAttemptResult =>
  Option.match(handoff, {
    onNone: () => result,
    onSome: (value) => ({ ...result, handoff: value }),
  });

const buildAgentAttemptResultEffect = (inputs: {
  attempt: number;
  context: RuntimeContext;
  decision: NodeModelDecision;
  fallbackEvidence: string[];
  model: Option.Option<string>;
  node: PlannedWorkflowNode;
  outcome: ModelAttemptOutcome;
  profileId: string;
}): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> =>
  Effect.gen(function* effectBody() {
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
    const handoff = yield* maybeDeriveHandoffEffect(inputs.context, inputs.node, finalized.output, inputs.attempt);
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

const runSelectedModelEffect = (inputs: {
  attempt: number;
  context: RuntimeContext;
  decision: NodeModelDecision;
  node: PlannedWorkflowNode;
  profileId: string;
  prompt: string;
}): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> =>
  Effect.gen(function* effectBody() {
    const fallbackEvidence: string[] = [];
    for (let index = 0; index < inputs.decision.candidates.length; index += 1) {
      const model = inputs.decision.candidates[index] ?? Option.none();
      const selectedModel = Option.getOrUndefined(model);
      const outcome = yield* runModelAttemptEffect({
        attempt: inputs.attempt,
        context: inputs.context,
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
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
        fallbackNote({
          failed: model,
          next: inputs.decision.candidates[index + 1] ?? Option.none(),
          result: outcome.result,
        }),
      );
    }
    return missingModelResult(inputs.node.id);
  });

const executeAgentNodeEffect = (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
): Effect.Effect<NodeAttemptResult, unknown, AgentNodeRuntimeService> =>
  Effect.gen(function* effectBody() {
    if (node.profile === undefined || node.profile.length === 0) {
      return missingProfileResult(node.id);
    }
    const prompt = yield* renderAgentPromptEffect(node, context);
    const decision = decideNodeModel(prompt, node, context.availableModels, context.config.token_budget);
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

export const executeAgentNode = async (
  node: PlannedWorkflowNode,
  context: RuntimeContext,
  attempt: number,
): Promise<NodeAttemptResult> => {
  const program = executeAgentNodeEffect(node, context, attempt);
  return await Effect.runPromise(Effect.provide(program, AgentNodeRuntimeServiceLive));
};
