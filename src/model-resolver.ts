import type { PipelineConfig } from "./config";
import type { PlannedWorkflowNode } from "./planning/compile";

export interface ModelSelection {
  model?: string;
  reason: string;
  skipped: string[];
}

type TokenBudget = PipelineConfig["token_budget"];

export interface ModelSizingOptions {
  budget: TokenBudget;
  estimatedTokens: number;
}

const DISABLED_MODELS_ENV = "PIPELINE_DISABLED_MODELS";

export function selectNodeModel(
  node: PlannedWorkflowNode,
  options?: ModelSizingOptions
): ModelSelection {
  const models = node.models ?? [];
  return fallbackModelSelection(models, options);
}

function fallbackModelSelection(
  models: string[],
  options?: ModelSizingOptions
): ModelSelection {
  if (models.length === 0) {
    return {
      reason: "node declares no model fallback array",
      skipped: [],
    };
  }
  const disabled = disabledModels();
  const enabled = models.filter((candidate) => !disabled.has(candidate));
  const disabledSkipped = models.filter((candidate) => disabled.has(candidate));
  if (!options) {
    const model = enabled[0];
    return {
      model,
      reason: selectionReason(model),
      skipped: disabledSkipped,
    };
  }
  return sizedSelection(enabled, disabledSkipped, options);
}

function sizedSelection(
  enabled: string[],
  disabledSkipped: string[],
  options: ModelSizingOptions
): ModelSelection {
  const { estimatedTokens, budget } = options;
  const required = estimatedTokens / (budget.max_context_pct / 100);
  const tooSmall: string[] = [];
  for (const candidate of enabled) {
    const window =
      budget.model_context_windows[candidate] ?? budget.default_context_window;
    if (window >= required) {
      return {
        model: candidate,
        reason: `selected '${candidate}' (window ${window}) — holds estimated ${estimatedTokens} tokens within the ${budget.max_context_pct}% context cap`,
        skipped: [...disabledSkipped, ...tooSmall],
      };
    }
    tooSmall.push(candidate);
  }
  return {
    reason: `estimated context ${estimatedTokens} tokens exceeds ${budget.max_context_pct}% of every available model window`,
    skipped: [...disabledSkipped, ...tooSmall],
  };
}

function selectionReason(model: string | undefined): string {
  if (model) {
    return "selected first enabled model from node fallback array";
  }
  return `all configured node models are disabled by ${DISABLED_MODELS_ENV}`;
}

function disabledModels(): Set<string> {
  return new Set(
    (process.env[DISABLED_MODELS_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}
