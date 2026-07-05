import { Effect, Option } from "effect";
import type { Scope } from "effect";

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

const applyPersistedSchedule = (
  options: PipelineRuntimeOptions,
  worktreePath: string,
  manifest: Option.Option<MokaRunManifest>
): PipelineRuntimeOptions => {
  const schedule = Option.isSome(manifest)
    ? manifest.value.schedule
    : undefined;
  if (schedule === undefined || schedule.length === 0) {
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
};

export const resolveResumeRuntimeOptions = (
  options: ResumeRuntimeOptions,
  dbUrl: Option.Option<string>
): Effect.Effect<PipelineRuntimeOptions, unknown, Scope.Scope> => {
  if (Option.isNone(dbUrl)) {
    return Effect.succeed(options);
  }
  const worktreePath = options.worktreePath ?? process.cwd();
  return resolveRunControlStore(dbUrl.value, worktreePath).pipe(
    Effect.flatMap((store) => store.readRun({ runId: options.runId })),
    Effect.map((manifest) =>
      applyPersistedSchedule(
        options,
        worktreePath,
        Option.fromUndefinedOr(manifest)
      )
    )
  );
};

export const acquireRunJournal = (
  runId: Option.Option<string>,
  dbUrl: Option.Option<string>
): Effect.Effect<Option.Option<RunJournal>, unknown, Scope.Scope> => {
  if (Option.isNone(runId) || Option.isNone(dbUrl)) {
    return Effect.succeed(Option.none());
  }
  return resolveDurableStore(dbUrl.value, runId.value).pipe(
    Effect.map((store) => Option.some(store.toRunJournal(runId.value)))
  );
};
