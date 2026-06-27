import { Effect, type Scope } from "effect";
import { loadPipelineConfig } from "../config";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import type { MokaRunManifest } from "../run-control/contracts";
import { resolveRunControlStore } from "../run-control/run-control-store";
import type { PipelineRuntimeOptions } from "./contracts";
import { resolveDurableStore } from "./durable-store/acquisition";
import type { RunJournal } from "./run-journal";

export interface ResumeRuntimeOptions extends PipelineRuntimeOptions {
  runId: string;
}

export function resolveResumeRuntimeOptions(
  options: ResumeRuntimeOptions,
  dbUrl: string | undefined
): Effect.Effect<PipelineRuntimeOptions, unknown, Scope.Scope> {
  if (dbUrl === undefined) {
    return Effect.succeed(options);
  }
  const worktreePath = options.worktreePath ?? process.cwd();
  return resolveRunControlStore(dbUrl, worktreePath).pipe(
    Effect.flatMap((store) => store.readRun({ runId: options.runId })),
    Effect.map((manifest) =>
      applyPersistedSchedule(options, manifest, worktreePath)
    )
  );
}

function applyPersistedSchedule(
  options: PipelineRuntimeOptions,
  manifest: MokaRunManifest | undefined,
  worktreePath: string
): PipelineRuntimeOptions {
  const schedule = manifest?.schedule;
  if (!schedule) {
    return options;
  }
  const baseConfig = options.config ?? loadPipelineConfig(worktreePath);
  const compiled = compileScheduleArtifact(
    baseConfig,
    parseScheduleArtifact(schedule, "persisted schedule"),
    worktreePath
  );
  return {
    ...options,
    config: compiled.config,
    workflowId: compiled.workflowId,
  };
}

export function acquireRunJournal(
  runId: string | undefined,
  dbUrl: string | undefined
): Effect.Effect<RunJournal | undefined, unknown, Scope.Scope> {
  if (runId === undefined || dbUrl === undefined) {
    return Effect.succeed(undefined);
  }
  return resolveDurableStore(dbUrl, runId).pipe(
    Effect.map((store) => store.toRunJournal(runId))
  );
}
