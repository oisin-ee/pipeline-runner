export { formatSchemaIssueList as formatSchemaIssues } from "../schema-boundary";

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
