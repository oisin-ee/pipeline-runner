import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { buildMokaSubmitInputFromCli } from "../cli/submit-options";
import { loadPipelineConfig } from "../config";
import { loadMokaDbUrl, loadMokaGlobalConfig } from "../moka-global-config";
import { submitMoka } from "../moka-submit";
import type { MokaSubmitOutput } from "../moka-submit";
import { resumeRunByOrigin } from "../pipeline-runtime";
import type {
  ResubmitRemoteRunInput,
  ResumeRunOptions,
  ResumeRunResult,
} from "../pipeline-runtime";
import { workspaceRoot } from "./command-context";

interface ResumeFlags {
  entrypoint?: string;
  workflow?: string;
}

// Effect CLI binds positional arguments in config-key order, and `sort-keys`
// forces those keys alphabetical. The variadic task description is keyed
// `taskDescription` (not `descriptionParts`) so it sorts AFTER the required
// `runId`; keying it `descriptionParts` would sort it first and the variadic
// would swallow the run-id token, matching the original `<run-id>
// <description...>` order.
const resumeFlags = {
  entrypoint: Flag.string("entrypoint").pipe(
    Flag.withDescription("entrypoint alias from package config"),
    Flag.optional
  ),
  runId: Argument.string("run-id").pipe(
    Argument.withDescription("the persisted run id to resume")
  ),
  taskDescription: Argument.string("description").pipe(
    Argument.withDescription("task description for the remaining nodes"),
    Argument.variadic({ min: 1 })
  ),
  workflow: Flag.string("workflow").pipe(
    Flag.withDescription("workflow id from package config"),
    Flag.optional
  ),
};

const normalizeResumeFlags = (
  flags: Command.Command.Config.Infer<typeof resumeFlags>
): {
  readonly flags: ResumeFlags;
  readonly runId: string;
  readonly task: string;
} => ({
  flags: {
    entrypoint: Option.getOrUndefined(flags.entrypoint),
    workflow: Option.getOrUndefined(flags.workflow),
  },
  runId: flags.runId,
  task: [...flags.taskDescription].join(" "),
});

/**
 * PIPE-94.8: re-submit a remote-origin run through the PIPE-94.4 submit path.
 * Lives in the CLI/run-control layer (not in core `pipeline-runtime`) so the
 * core stays free of a CLI/submit import cycle. The submission context (event
 * sink, image, namespace, secrets, broker auth) is reassembled from the Moka
 * global config by the SAME builder a fresh `moka submit` uses
 * ({@link buildMokaSubmitInputFromCli}); the PERSISTED schedule is then
 * substituted so the ORIGINAL run graph re-submits — not a freshly planned one —
 * and the runId is pinned via `generateRunId` so createRun stays idempotent
 * (progress preserved). The full DAG re-submits; the in-pod skip-already-passed
 * check drains only the remaining nodes.
 */
const defaultResubmitRemoteRun = async (
  input: ResubmitRemoteRunInput
): Promise<MokaSubmitOutput> => {
  const worktreePath = input.worktreePath ?? process.cwd();
  const config =
    input.config ??
    loadPipelineConfig(worktreePath, { allowMissingLintFileReferences: true });
  const submitInput = buildMokaSubmitInputFromCli({
    config,
    cwd: worktreePath,
    flags: {},
    globalConfig: loadMokaGlobalConfig() ?? undefined,
    input: [input.task],
  });
  if (submitInput.type !== "graph") {
    throw new Error(
      `Cannot re-submit remote run '${input.runId}': expected a graph submission.`
    );
  }
  return await submitMoka(
    {
      ...submitInput,
      schedulePath: undefined,
      scheduleYaml: input.scheduleYaml,
    },
    { generateRunId: () => input.runId }
  );
};

const resumeRunOptions = (
  runId: string,
  task: string,
  flags: ResumeFlags
): ResumeRunOptions => ({
  dbUrl: loadMokaDbUrl(),
  entrypoint: flags.entrypoint,
  runId,
  task,
  workflowId: flags.workflow,
  worktreePath: workspaceRoot(),
});

const recordResumeResult = (runId: string, outcome: string): void => {
  process.exitCode = outcome === "PASS" ? process.exitCode : 1;
};

const reportResumeResult = (runId: string, result: ResumeRunResult): void => {
  if (result.kind === "remote") {
    return;
  }
  recordResumeResult(runId, result.result.outcome);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const recordResumeFailure = (runId: string, error: unknown): void => {
  process.stderr.write(
    `Failed to resume run ${runId}: ${errorMessage(error)}\n`
  );
  process.exitCode = 1;
};

const resumeRunFromCli = async (
  runId: string,
  task: string,
  flags: ResumeFlags
): Promise<void> => {
  try {
    const result = await resumeRunByOrigin(
      resumeRunOptions(runId, task, flags),
      {
        resubmit: defaultResubmitRemoteRun,
      }
    );
    reportResumeResult(runId, result);
  } catch (error) {
    recordResumeFailure(runId, error);
  }
};

export const createResumeCommand = () =>
  Command.make("resume", resumeFlags, (rawFlags) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const { flags, runId, task } = normalizeResumeFlags(rawFlags);
        await resumeRunFromCli(runId, task, flags);
      },
    })
  ).pipe(
    Command.withDescription(
      "Rehydrate a persisted run from the durable store and continue it"
    )
  );
