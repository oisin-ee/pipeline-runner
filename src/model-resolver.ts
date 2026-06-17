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

export interface ModelSelectionOptions extends Partial<ModelSizingOptions> {
  /**
   * Models actually resolvable in the runtime (e.g. providers authenticated in
   * the leased opencode server). When provided, candidates outside the set are
   * skipped like disabled models, so a preferred-but-unavailable provider
   * (opencode-go) falls back to the next candidate (gpt-5.5/...) instead of
   * being selected and then failing at dispatch. Omitted → no availability
   * filtering (legacy behaviour).
   */
  available?: ReadonlySet<string>;
}

const DISABLED_MODELS_ENV = "PIPELINE_DISABLED_MODELS";

export function selectNodeModel(
  node: PlannedWorkflowNode,
  options?: ModelSelectionOptions
): ModelSelection {
  const models = node.models ?? [];
  return fallbackModelSelection(models, options);
}

function fallbackModelSelection(
  models: string[],
  options?: ModelSelectionOptions
): ModelSelection {
  if (models.length === 0) {
    return {
      reason: "node declares no model fallback array",
      skipped: [],
    };
  }
  const disabled = disabledModels();
  const available = options?.available;
  const enabled = models.filter(
    (candidate) => !disabled.has(candidate) && isAvailable(candidate, available)
  );
  const skipped = models.filter(
    (candidate) => disabled.has(candidate) || !isAvailable(candidate, available)
  );
  const sizing = sizingFromOptions(options);
  if (!sizing) {
    const model = enabled[0];
    return {
      model,
      reason: selectionReason(model),
      skipped,
    };
  }
  return sizedSelection(enabled, skipped, sizing);
}

function isAvailable(
  candidate: string,
  available: ReadonlySet<string> | undefined
): boolean {
  return available ? available.has(candidate) : true;
}

function sizingFromOptions(
  options: ModelSelectionOptions | undefined
): ModelSizingOptions | undefined {
  if (options?.budget && typeof options.estimatedTokens === "number") {
    return { budget: options.budget, estimatedTokens: options.estimatedTokens };
  }
  return;
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
