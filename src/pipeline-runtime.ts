import { Effect, type Scope } from "effect";
import type { PipelineConfigError } from "./config";
import { loadMokaDbUrl } from "./moka-global-config";
import type { MokaSubmitOutput } from "./moka-submit";
import type { MokaRunManifest, RunTarget } from "./run-control/contracts";
import { resolveRunControlStore } from "./run-control/run-control-store";
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

/**
 * PIPE-94.8: the input to a remote re-submission. Carries only what the durable
 * manifest persists (the schedule artifact) plus the resume context — the same
 * runId so createRun stays idempotent and the full DAG re-submits without wiping
 * progress.
 */
export interface ResubmitRemoteRunInput {
  config: ResumeRunOptions["config"];
  runId: string;
  scheduleYaml: string;
  task: string;
  worktreePath: string | undefined;
}

export type ResubmitRemoteRun = (
  input: ResubmitRemoteRunInput
) => Promise<MokaSubmitOutput>;

/**
 * PIPE-94.8: the two-origin outcome of an origin-aware resume. A local-origin run
 * is executed in-process (the existing {@link PipelineRuntimeResult}); a
 * remote-origin run is re-submitted to Argo (the submission descriptor).
 */
export type ResumeRunResult =
  | { kind: "local"; result: PipelineRuntimeResult }
  | { kind: "remote"; submission: MokaSubmitOutput };

/**
 * PIPE-94.8: injectable seams for {@link resumeRunByOrigin}. All default to the
 * production implementations; tests inject spies to assert routing without a
 * Postgres substrate or a live Argo cluster.
 */
export interface ResumeByOriginDependencies {
  readManifest?: (
    options: ResumeRunOptions
  ) => Promise<MokaRunManifest | undefined>;
  resubmit?: ResubmitRemoteRun;
  runLocal?: (options: ResumeRunOptions) => Promise<PipelineRuntimeResult>;
}

interface ResumeStrategyContext {
  manifest: MokaRunManifest | undefined;
  options: ResumeRunOptions;
  resubmit: ResubmitRemoteRun | undefined;
  runLocal: (options: ResumeRunOptions) => Promise<PipelineRuntimeResult>;
}

/**
 * PIPE-94.8: data-driven origin dispatch keyed by the manifest's `target`. A
 * local-origin run continues in-process (current behaviour, byte-identical); a
 * remote-origin run re-submits the SAME persisted schedule to Argo under the SAME
 * runId — passed nodes are skipped in-pod from the durable store, so only the
 * remaining nodes run. No origin / no manifest defaults to local.
 *
 * Submission is an outer-layer (CLI) capability, so there is no core default for
 * `resubmit`: the resume command injects it (keeping core free of a CLI/submit
 * import cycle). A remote run with no injected `resubmit` fails clearly.
 */
const resumeStrategies: Record<
  RunTarget,
  (context: ResumeStrategyContext) => Promise<ResumeRunResult>
> = {
  local: (context) =>
    context
      .runLocal(context.options)
      .then((result) => ({ kind: "local", result })),
  remote: (context) =>
    requireResubmit(context)(remoteResubmitInput(context)).then(
      (submission) => ({ kind: "remote", submission })
    ),
};

function requireResubmit(context: ResumeStrategyContext): ResubmitRemoteRun {
  if (context.resubmit === undefined) {
    throw new Error(
      `Cannot re-submit remote run '${context.options.runId}': no remote re-submit handler was provided to resumeRunByOrigin.`
    );
  }
  return context.resubmit;
}

export function resumeRunByOrigin(
  options: ResumeRunOptions,
  dependencies: ResumeByOriginDependencies = {}
): Promise<ResumeRunResult> {
  const context: ResumeStrategyContext = {
    manifest: undefined,
    options,
    resubmit: dependencies.resubmit,
    runLocal: dependencies.runLocal ?? resumeRun,
  };
  const readManifest = dependencies.readManifest ?? defaultReadResumeManifest;
  return resolveResumeManifest(options, readManifest).then((manifest) =>
    resumeStrategies[manifest?.target ?? "local"]({ ...context, manifest })
  );
}

function resolveResumeManifest(
  options: ResumeRunOptions,
  readManifest: (
    options: ResumeRunOptions
  ) => Promise<MokaRunManifest | undefined>
): Promise<MokaRunManifest | undefined> {
  // db.url absent → the manifest is unreadable, so origin is unknown; fall back
  // to the local path, whose resume guard surfaces the clear "no durable store"
  // error rather than silently no-opping.
  if (options.dbUrl === undefined) {
    return Promise.resolve(undefined);
  }
  return readManifest(options);
}

function remoteResubmitInput(
  context: ResumeStrategyContext
): ResubmitRemoteRunInput {
  const scheduleYaml = context.manifest?.schedule;
  if (!scheduleYaml) {
    throw new Error(
      `Cannot re-submit remote run '${context.options.runId}': the persisted manifest has no schedule to rebuild the Argo workflow from.`
    );
  }
  return {
    config: context.options.config,
    runId: context.options.runId,
    scheduleYaml,
    task: context.options.task,
    worktreePath: context.options.worktreePath,
  };
}

function defaultReadResumeManifest(
  options: ResumeRunOptions
): Promise<MokaRunManifest | undefined> {
  const dbUrl = options.dbUrl;
  if (dbUrl === undefined) {
    return Promise.resolve(undefined);
  }
  const worktreePath = options.worktreePath ?? process.cwd();
  return Effect.runPromise(
    Effect.scoped(
      resolveRunControlStore(dbUrl, worktreePath).pipe(
        Effect.flatMap((store) => store.readRun({ runId: options.runId }))
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
