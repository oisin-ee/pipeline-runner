import { Effect, type Scope } from "effect";
import type { PipelineConfigError } from "./config";
import { loadMokaDbUrl } from "./moka-global-config";
import { formatConfigError as formatRuntimeConfigError } from "./runtime/config-error";
import { createRuntimeContext } from "./runtime/context";
import type {
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
  RuntimeNodeResult,
} from "./runtime/contracts";
import {
  acquireRunJournal as acquireRuntimeRunJournal,
  type ResumeRuntimeOptions,
  resolveResumeRuntimeOptions,
} from "./runtime/journal-acquisition";
import { withOpencodeRuntime } from "./runtime/opencode-runtime";
import type { RunJournal } from "./runtime/run-journal";
import type { ScheduledDependencyOutputs } from "./runtime/scheduled-dependencies";
import {
  executeScheduledWorkflowTaskWithContext,
  resumeRunWithContext,
  runPipelineWithContext,
} from "./runtime/workflow-execution";

export type {
  AcceptanceCriterion,
  HookRuntimePolicy,
  NodeExecutionState,
  NodeStatus,
  PipelineRuntimeEvent,
  PipelineRuntimeObservabilityLevel,
  PipelineRuntimeOptions,
  PipelineRuntimeResult,
  PipelineTaskContext,
  RuntimeFailure,
  RuntimeGateResult,
  RuntimeNodeResult,
  RuntimeStructuredOutput,
} from "./runtime/contracts";

export interface ScheduledWorkflowTaskRuntimeOptions
  extends PipelineRuntimeOptions {
  dependencyOutputs?: ScheduledDependencyOutputs;
  nodeId: string;
}

export interface ResumeRunOptions extends ResumeRuntimeOptions {
  dbUrl: string | undefined;
}

export function formatConfigError(err: PipelineConfigError): string {
  return formatRuntimeConfigError(err);
}

export function acquireRunJournal(
  runId: string | undefined,
  dbUrl: string | undefined
): Effect.Effect<RunJournal | undefined, unknown, Scope.Scope> {
  return acquireRuntimeRunJournal(runId, dbUrl);
}

export function runPipelineFromConfig(
  options: PipelineRuntimeOptions
): Promise<PipelineRuntimeResult> {
  const dbUrl = loadMokaDbUrl();
  return Effect.runPromise(
    withOpencodeRuntime(options, (resolved) =>
      runPipelineWithContext(createRuntimeContext(resolved), dbUrl)
    )
  );
}

export function resumeRun(
  options: ResumeRunOptions
): Promise<PipelineRuntimeResult> {
  const { dbUrl, ...runtimeOptions } = options;
  return Effect.runPromise(
    Effect.scoped(
      resolveResumeRuntimeOptions(runtimeOptions, dbUrl).pipe(
        Effect.flatMap((resolved) =>
          withOpencodeRuntime(resolved, (inner) =>
            resumeRunWithContext(createRuntimeContext(inner), dbUrl)
          )
        )
      )
    )
  );
}

export function runScheduledWorkflowTask(
  options: ScheduledWorkflowTaskRuntimeOptions
): Promise<RuntimeNodeResult> {
  const { dependencyOutputs, nodeId, ...runtimeOptions } = options;
  return Effect.runPromise(
    withOpencodeRuntime(runtimeOptions, (resolved) =>
      executeScheduledWorkflowTaskWithContext(
        createRuntimeContext(resolved),
        nodeId,
        dependencyOutputs
      )
    )
  );
}
