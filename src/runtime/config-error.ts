import type { PipelineConfigError } from "../config";

export const formatConfigError = (err: PipelineConfigError): string =>
  [
    err.message,
    ...err.issues.map((issue) =>
      issue.path !== undefined && issue.path.length > 0
        ? `- ${issue.path}: ${issue.message}`
        : `- ${issue.message}`
    ),
  ].join("\n");
