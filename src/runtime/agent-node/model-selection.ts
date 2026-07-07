import { Option } from "effect";

import type { PipelineConfig } from "../../config";
import { selectNodeModelCandidates } from "../../model-resolver";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { AgentResult } from "../../runner";
import { estimateTokens } from "../../token-estimator";

export interface NodeModelDecision {
  candidates: Option.Option<string>[];
  estimatedTokens: number;
  overBudget: boolean;
  reason: string;
  skipped: string[];
}

interface TokenSizing {
  budget: PipelineConfig["token_budget"];
  estimatedTokens: number;
}

const tokenSizing = (
  estimatedTokens: number,
  budget?: PipelineConfig["token_budget"]
): Partial<TokenSizing> =>
  budget === undefined ? {} : { budget, estimatedTokens };

const selectedCandidates = (models: string[]): Option.Option<string>[] =>
  models.length > 0 ? models.map(Option.some) : [Option.none()];

const noCandidateFitsBudget = (
  node: PlannedWorkflowNode,
  models: string[],
  budget?: PipelineConfig["token_budget"]
): boolean =>
  budget !== undefined &&
  node.models !== undefined &&
  node.models.length > 0 &&
  models.length === 0;

export const decideNodeModel = (
  prompt: string,
  node: PlannedWorkflowNode,
  availableModels?: ReadonlySet<string>,
  budget?: PipelineConfig["token_budget"]
): NodeModelDecision => {
  const estimatedTokens = estimateTokens(prompt);
  const candidates = selectNodeModelCandidates(node, {
    available: availableModels,
    ...tokenSizing(estimatedTokens, budget),
  });
  return {
    candidates: selectedCandidates(candidates.models),
    estimatedTokens,
    overBudget: noCandidateFitsBudget(node, candidates.models, budget),
    reason: candidates.reason,
    skipped: candidates.skipped,
  };
};

export const modelLabel = (model: Option.Option<string>): string =>
  Option.match(model, {
    onNone: () => "profile/default",
    onSome: (value) => value,
  });

export const fallbackNote = (input: {
  failed: Option.Option<string>;
  next: Option.Option<string>;
  result: AgentResult;
}): string => {
  const { failed, next, result } = input;
  const detail =
    result.stderr === undefined || result.stderr.length === 0
      ? ""
      : `: ${result.stderr}`;
  return `model ${modelLabel(failed)} failed (infra exit ${result.exitCode}${detail}); falling back to ${modelLabel(next)}`;
};
