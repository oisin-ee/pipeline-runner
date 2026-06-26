// fallow-ignore-file unused-file
import { Context, Effect, Layer } from "effect";
import type { PipelineGoalState } from "../goal-state/goal-state";

// fallow-ignore-next-line unused-type
export type GoalLoopTerminalState =
  | "blocked"
  | "cancelled"
  | "max_continuations_reached"
  | "no_progress_detected"
  | "passed";

// fallow-ignore-next-line unused-type
export interface GoalLoopContinuationInput {
  attempt: number;
  prompt: string;
  promptPath?: string;
  state: PipelineGoalState;
}

// fallow-ignore-next-line unused-type
export interface GoalLoopOptions {
  initialState: PipelineGoalState;
  maxContinuations: number;
  now?: () => Date;
  runContinuation: (
    input: GoalLoopContinuationInput
  ) => PipelineGoalState | Promise<PipelineGoalState>;
  shouldCancel?: () => boolean;
  writePrompt?: (
    attempt: number,
    prompt: string,
    state: PipelineGoalState
  ) => string | Promise<string>;
}

// fallow-ignore-next-line unused-type
export interface GoalLoopResult {
  attempts: number;
  prompts: string[];
  reason: string;
  state: PipelineGoalState;
  terminalState: GoalLoopTerminalState;
}

// fallow-ignore-next-line unused-export
export class GoalLoopService extends Context.Service<
  GoalLoopService,
  {
    readonly runContinuation: (
      runner: GoalLoopOptions["runContinuation"],
      input: GoalLoopContinuationInput
    ) => Effect.Effect<PipelineGoalState, unknown>;
    readonly writePrompt: (
      writer: GoalLoopOptions["writePrompt"],
      attempt: number,
      prompt: string,
      state: PipelineGoalState
    ) => Effect.Effect<string | undefined, unknown>;
  }
>()("GoalLoopService") {}

// fallow-ignore-next-line unused-export
export const GoalLoopServiceLive = Layer.succeed(GoalLoopService, {
  runContinuation: (runner, input) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: () => Promise.resolve(runner(input)),
    }),
  writePrompt: (writer, attempt, prompt, state) =>
    optionalWritePromptEffect(writer, attempt, prompt, state),
});

function optionalWritePromptEffect(
  writer: GoalLoopOptions["writePrompt"],
  attempt: number,
  prompt: string,
  state: PipelineGoalState
): Effect.Effect<string | undefined, unknown> {
  return writer
    ? Effect.tryPromise({
        catch: (error) => error,
        try: () => Promise.resolve(writer(attempt, prompt, state)),
      })
    : Effect.succeed(undefined);
}
