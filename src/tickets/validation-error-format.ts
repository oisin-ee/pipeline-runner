import type { z } from "zod";

export function formatZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
