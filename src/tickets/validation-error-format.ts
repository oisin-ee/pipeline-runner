import type { z } from "zod";

export const formatZodIssues = (issues: readonly z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
