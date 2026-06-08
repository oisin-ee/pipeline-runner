import type { RunnerJobPayload } from "../runner-job-contract.js";
import type {
  PipelineRuntimeResult,
  RuntimeStructuredOutput,
} from "../runtime/contracts";
import { standardOutputSchemaPath } from "../standard-output-schemas.js";

export interface RunnerPullRequestMetadata {
  branch: string;
  commitSha: string | null;
  orchestrator: string;
  scheduleId: string;
  schedulePath: string;
}

export interface RunnerPullRequestSummary {
  body: string;
  title: string;
}

interface ImplementationChange {
  files: string[];
  nodeId: string;
  summary: string;
  why: string;
}

export function renderRunnerPullRequestSummary(input: {
  metadata: RunnerPullRequestMetadata;
  payload: RunnerJobPayload;
  result: PipelineRuntimeResult;
}): RunnerPullRequestSummary {
  const implementation = implementationOutputs(input.result);
  const changes = implementation.flatMap((output) =>
    implementationChanges(output)
  );
  if (changes.length === 0) {
    throw new Error(
      "Runner PR summary requires at least one validated implementation change"
    );
  }

  const verification = uniqueStrings([
    ...implementation.flatMap((output) =>
      stringArray(output.output, "verification")
    ),
    ...validatedOutputsForSchema(input.result, "verify").flatMap((output) =>
      stringArray(output.output, "evidence")
    ),
  ]);
  const risks = uniqueStrings([
    ...implementation.flatMap((output) => stringArray(output.output, "risks")),
    ...implementation.flatMap((output) =>
      stringArray(output.output, "followups")
    ),
    ...validatedOutputsForSchema(input.result, "research").flatMap((output) =>
      stringArray(output.output, "risks")
    ),
  ]);
  const lessons = uniqueStrings([
    ...implementation.flatMap((output) =>
      stringArray(output.output, "lessons")
    ),
    ...validatedOutputsForSchema(input.result, "learn").flatMap((output) =>
      stringArray(output.output, "evidence")
    ),
  ]);

  return {
    body: renderBody({
      changes,
      lessons,
      metadata: input.metadata,
      payload: input.payload,
      result: input.result,
      risks,
      verification,
    }),
    title: renderTitle(input.payload, changes),
  };
}

function implementationOutputs(
  result: PipelineRuntimeResult
): RuntimeStructuredOutput[] {
  return validatedOutputsForSchema(result, "implementation");
}

function validatedOutputsForSchema(
  result: PipelineRuntimeResult,
  schemaName: Parameters<typeof standardOutputSchemaPath>[0]
): RuntimeStructuredOutput[] {
  const schemaPath = standardOutputSchemaPath(schemaName);
  return result.structuredOutputs.filter(
    (output) =>
      output.schemaPath === schemaPath &&
      output.validation.status === "valid" &&
      output.validation.passed
  );
}

function implementationChanges(
  output: RuntimeStructuredOutput
): ImplementationChange[] {
  const changes = recordArray(output.output, "changes");
  return changes.flatMap((change) => {
    const summary = stringValue(change.summary);
    const why = stringValue(change.why);
    const files = Array.isArray(change.files)
      ? change.files.flatMap((file) => {
          const value = stringValue(file);
          return value ? [value] : [];
        })
      : [];
    if (!(summary && why) || files.length === 0) {
      return [];
    }
    return [{ files, nodeId: output.nodeId, summary, why }];
  });
}

function renderTitle(
  payload: RunnerJobPayload,
  changes: ImplementationChange[]
): string {
  const taskTitle =
    payload.task.kind === "ticket"
      ? payload.task.title || payload.task.id
      : payload.task.title;
  return `Pipeline: ${taskTitle || changes[0]?.summary || payload.run.id}`;
}

function renderBody(input: {
  changes: ImplementationChange[];
  lessons: string[];
  metadata: RunnerPullRequestMetadata;
  payload: RunnerJobPayload;
  result: PipelineRuntimeResult;
  risks: string[];
  verification: string[];
}): string {
  return [
    "## Summary",
    `Pipeline run ${input.payload.run.id} completed with outcome ${input.result.outcome}.`,
    "",
    "## Changes",
    ...input.changes.flatMap((change) => [
      `- ${change.summary}`,
      `  - Why: ${change.why}`,
      `  - Files: ${change.files.join(", ")}`,
      `  - Node: ${change.nodeId}`,
    ]),
    "",
    "## Verification",
    ...bullets(input.verification, [
      "- No verification evidence was reported.",
    ]),
    "",
    "## Risks",
    ...bullets(input.risks, ["- None reported."]),
    "",
    "## Lessons",
    ...bullets(input.lessons, ["- None reported."]),
    "",
    "## Pipeline Run",
    `- Run ID: ${input.payload.run.id}`,
    `- Project: ${input.payload.run.project}`,
    `- Schedule ID: ${input.metadata.scheduleId}`,
    `- Schedule Path: ${input.metadata.schedulePath}`,
    `- Workflow: ${input.result.plan.workflowId}`,
    `- Orchestrator: ${input.metadata.orchestrator}`,
    "",
    "## Delivery Metadata",
    `- Repository: ${input.payload.repository.url}`,
    `- Base Branch: ${input.payload.repository.baseBranch}`,
    `- Branch: ${input.metadata.branch}`,
    `- Commit: ${input.metadata.commitSha ?? "no new commit"}`,
  ].join("\n");
}

function bullets(values: string[], empty: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : empty;
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  const field = value[key];
  return Array.isArray(field) ? field.filter(isRecord) : [];
}

function stringArray(value: unknown, key: string): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const field = value[key];
  if (!Array.isArray(field)) {
    return [];
  }
  return field.flatMap((item) => {
    const value = stringValue(item);
    return value ? [value] : [];
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
