import type { PlannedWorkflowNode } from "./workflow-planner";

export interface ModelSelection {
  model?: string;
  reason: string;
  skipped: string[];
}

const DISABLED_MODELS_ENV = "PIPELINE_DISABLED_MODELS";

export function selectNodeModel(node: PlannedWorkflowNode): ModelSelection {
  const models = node.models ?? [];
  if (models.length === 0) {
    return {
      reason: "node declares no model fallback array",
      skipped: [],
    };
  }
  const disabled = disabledModels();
  const skipped = models.filter((model) => disabled.has(model));
  const model = models.find((candidate) => !disabled.has(candidate));
  return {
    model,
    reason: model
      ? "selected first enabled model from node fallback array"
      : `all configured node models are disabled by ${DISABLED_MODELS_ENV}`,
    skipped,
  };
}

function disabledModels(): Set<string> {
  return new Set(
    (process.env[DISABLED_MODELS_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}
