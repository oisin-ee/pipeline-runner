import { Context, Effect, Layer, Option } from "effect";

import type { PipelineGoalState } from "../goal-state/goal-state";

const NO_PROMPT_PATH: Option.Option<string> = Option.none();

export type GoalLoopTerminalState =
  | "blocked"
  | "cancelled"
  | "max_continuations_reached"
  | "no_progress_detected"
  | "passed";

export interface GoalLoopContinuationInput {
  attempt: number;
  prompt: string;
  promptPath?: string;
  state: PipelineGoalState;
}

export interface GoalLoopOptions {
  initialState: PipelineGoalState;
  maxContinuations: number;
  now?: () => Date;
  runContinuation: (input: GoalLoopContinuationInput) => PipelineGoalState | Promise<PipelineGoalState>;
  shouldCancel?: () => boolean;
  writePrompt?: (attempt: number, prompt: string, state: PipelineGoalState) => string | Promise<string>;
}

export interface GoalLoopResult {
  attempts: number;
  prompts: string[];
  reason: string;
  state: PipelineGoalState;
  terminalState: GoalLoopTerminalState;
}

export class GoalLoopService extends Context.Service<
  GoalLoopService,
  {
    readonly runContinuation: (
      runner: GoalLoopOptions["runContinuation"],
      input: GoalLoopContinuationInput,
    ) => Effect.Effect<PipelineGoalState, unknown>;
    readonly writePrompt: (
      writer: GoalLoopOptions["writePrompt"],
      attempt: number,
      prompt: string,
      state: PipelineGoalState,
    ) => Effect.Effect<Option.Option<string>, unknown>;
  }
>()("GoalLoopService") {}

const optionalWritePromptEffect = (
  writer: GoalLoopOptions["writePrompt"],
  attempt: number,
  prompt: string,
  state: PipelineGoalState,
): Effect.Effect<Option.Option<string>, unknown> =>
  writer === undefined
    ? Effect.succeed(NO_PROMPT_PATH)
    : Effect.tryPromise({
        catch: (error) => error,
        try: async () => Option.some(await writer(attempt, prompt, state)),
      });

export const GoalLoopServiceLive = Layer.succeed(GoalLoopService, {
  runContinuation: (runner, input) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => await runner(input),
    }),
  writePrompt: (writer, attempt, prompt, state) => optionalWritePromptEffect(writer, attempt, prompt, state),
});
