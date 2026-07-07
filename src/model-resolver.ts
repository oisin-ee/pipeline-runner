import * as Option from "effect/Option";

import type { PipelineConfig } from "./config";
import type { PlannedWorkflowNode } from "./planning/compile";

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

/**
 * The ordered list of models worth attempting for a node. A node's model array
 * is a fallback SET: the runner tries them in declared order and only falls
 * through to the next when one's session fails at runtime (provider/server
 * error), so availability checks at selection time are not the last line of
 * defence. `models` is every candidate that is enabled, available, and (when a
 * budget is supplied) fits the context cap, in priority order; the head is the
 * preferred model. `skipped` collects the disabled/unavailable/over-window
 * candidates for evidence.
 */
export interface ModelCandidates {
  models: string[];
  reason: string;
  skipped: string[];
}

const sizedCandidates = (
  enabled: string[],
  baseSkipped: string[],
  options: ModelSizingOptions
): ModelCandidates => {
  const { estimatedTokens, budget } = options;
  const required = estimatedTokens / (budget.max_context_pct / 100);
  const fits: string[] = [];
  const tooSmall: string[] = [];
  for (const candidate of enabled) {
    const window =
      budget.model_context_windows[candidate] ?? budget.default_context_window;
    if (window >= required) {
      fits.push(candidate);
    } else {
      tooSmall.push(candidate);
    }
  }
  const [head] = fits;
  const reason = head
    ? `selected '${head}' (window ${budget.model_context_windows[head] ?? budget.default_context_window}) — holds estimated ${estimatedTokens} tokens within the ${budget.max_context_pct}% context cap`
    : `estimated context ${estimatedTokens} tokens exceeds ${budget.max_context_pct}% of every available model window`;
  return { models: fits, reason, skipped: [...baseSkipped, ...tooSmall] };
};

const isAvailable = (
  candidate: string,
  available?: ReadonlySet<string>
): boolean => (available === undefined ? true : available.has(candidate));

const sizingFromOptions = (
  options?: ModelSelectionOptions
): Option.Option<ModelSizingOptions> => {
  if (
    options?.budget !== undefined &&
    typeof options.estimatedTokens === "number"
  ) {
    return Option.some({
      budget: options.budget,
      estimatedTokens: options.estimatedTokens,
    });
  }
  return Option.none();
};

const selectionReason = (model?: string): string => {
  if (model !== undefined && model !== "") {
    return "selected first enabled model from node fallback array";
  }
  return `all configured node models are disabled by ${DISABLED_MODELS_ENV}`;
};

const disabledModels = (): Set<string> =>
  new Set(
    (process.env[DISABLED_MODELS_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );

export const selectNodeModelCandidates = (
  node: PlannedWorkflowNode,
  options?: ModelSelectionOptions
): ModelCandidates => {
  const models = node.models ?? [];
  if (models.length === 0) {
    return {
      models: [],
      reason: "node declares no model fallback array",
      skipped: [],
    };
  }
  const disabled = disabledModels();
  const available = options?.available;
  const enabled = models.filter(
    (candidate) => !disabled.has(candidate) && isAvailable(candidate, available)
  );
  const baseSkipped = models.filter(
    (candidate) => disabled.has(candidate) || !isAvailable(candidate, available)
  );
  const sizing = sizingFromOptions(options);
  if (Option.isNone(sizing)) {
    return {
      models: enabled,
      reason: selectionReason(enabled[0]),
      skipped: baseSkipped,
    };
  }
  return sizedCandidates(enabled, baseSkipped, sizing.value);
};
