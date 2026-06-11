import type { PlannedWorkflowNode } from "./workflow-planner";

export interface ModelSelection {
  model?: string;
  reason: string;
  skipped: string[];
}

const DISABLED_MODELS_ENV = "PIPELINE_DISABLED_MODELS";
const MODEL_OVERRIDE_ENV = "PIPELINE_OPENCODE_MODEL";

export function selectNodeModel(node: PlannedWorkflowNode): ModelSelection {
  const models = node.models ?? [];
  return forcedModelSelection(models) ?? fallbackModelSelection(models);
}

function forcedModelSelection(models: string[]): ModelSelection | undefined {
  const override = process.env[MODEL_OVERRIDE_ENV]?.trim();
  if (!override) {
    return;
  }
  return {
    model: override,
    reason: `forced by ${MODEL_OVERRIDE_ENV}`,
    skipped: models,
  };
}

function fallbackModelSelection(models: string[]): ModelSelection {
  if (models.length === 0) {
    return {
      reason: "node declares no model fallback array",
      skipped: [],
    };
  }
  const disabled = disabledModels();
  return enabledModelSelection(models, disabled);
}

function enabledModelSelection(
  models: string[],
  disabled: Set<string>
): ModelSelection {
  const model = models.find((candidate) => !disabled.has(candidate));
  return {
    model,
    reason: selectionReason(model),
    skipped: models.filter((candidate) => disabled.has(candidate)),
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
