import type { PipelineConfig } from "../../config";
import { selectNodeModelCandidates } from "../../model-resolver";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { AgentResult } from "../../runner";
import { estimateTokens } from "../../token-estimator";

export interface NodeModelDecision {
  candidates: (string | undefined)[];
  estimatedTokens: number;
  overBudget: boolean;
  reason: string;
  skipped: string[];
}

interface TokenSizing {
  budget: PipelineConfig["token_budget"];
  estimatedTokens: number;
}

export function decideNodeModel(
  prompt: string,
  node: PlannedWorkflowNode,
  budget: PipelineConfig["token_budget"] | undefined,
  availableModels: ReadonlySet<string> | undefined
): NodeModelDecision {
  const estimatedTokens = estimateTokens(prompt);
  const candidates = selectNodeModelCandidates(node, {
    available: availableModels,
    ...tokenSizing(budget, estimatedTokens),
  });
  return {
    candidates: selectedCandidates(candidates.models),
    estimatedTokens,
    overBudget: noCandidateFitsBudget(budget, node, candidates.models),
    reason: candidates.reason,
    skipped: candidates.skipped,
  };
}

function tokenSizing(
  budget: PipelineConfig["token_budget"] | undefined,
  estimatedTokens: number
): Partial<TokenSizing> {
  return budget ? { budget, estimatedTokens } : {};
}

function selectedCandidates(models: string[]): (string | undefined)[] {
  return models.length ? models : [undefined];
}

function noCandidateFitsBudget(
  budget: PipelineConfig["token_budget"] | undefined,
  node: PlannedWorkflowNode,
  models: string[]
): boolean {
  return Boolean(budget && node.models?.length) && models.length === 0;
}

export function modelLabel(model: string | undefined): string {
  return model ?? "profile/default";
}

export function fallbackNote(
  failed: string | undefined,
  next: string | undefined,
  result: AgentResult
): string {
  const detail = result.stderr ? `: ${result.stderr}` : "";
  return `model ${modelLabel(failed)} failed (infra exit ${result.exitCode}${detail}); falling back to ${modelLabel(next)}`;
}
