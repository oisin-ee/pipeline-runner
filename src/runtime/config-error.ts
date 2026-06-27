import type { PipelineConfigError } from "../config";

export function formatConfigError(err: PipelineConfigError): string {
  return [
    err.message,
    ...err.issues.map((issue) =>
      issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`
    ),
  ].join("\n");
}
