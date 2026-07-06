import { Effect, Option } from "effect";

import type { PipelineConfig } from "../../config";
import type { RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
import {
  goalStateCompletionEvidence,
  goalStateFailureSignature,
  markGoalStateBlocked,
  recordGoalStateContinuationAttempt,
} from "../goal-state/goal-state";
import type { PipelineGoalState } from "../goal-state/goal-state";
import { GoalLoopService, GoalLoopServiceLive } from "../services/goal-loop-service";
import type {
  GoalLoopContinuationInput as GoalLoopContinuationInputType,
  GoalLoopOptions,
  GoalLoopResult,
} from "../services/goal-loop-service";
import { exactNextRequirement, renderContinuationPrompt } from "./continuation-prompt";

export type { GoalLoopOptions, GoalLoopResult } from "../services/goal-loop-service";

const isValidMaxContinuations = (value: number): boolean => Number.isInteger(value) && value >= 0;

const assertValidMaxContinuations = (options: GoalLoopOptions): GoalLoopOptions => {
  if (isValidMaxContinuations(options.maxContinuations)) {
    return options;
  }
  throw new Error("maxContinuations must be a non-negative integer");
};

const validateGoalLoopOptions = (options: GoalLoopOptions): Effect.Effect<GoalLoopOptions, unknown> =>
  Effect.try({
    catch: (error) => error,
    try: () => assertValidMaxContinuations(options),
  });

const maxContinuationsResult = (
  state: PipelineGoalState,
  prompts: string[],
  options: GoalLoopOptions,
): Option.Option<GoalLoopResult> =>
  state.continuationAttempts.length >= options.maxContinuations
    ? Option.some({
        attempts: state.continuationAttempts.length,
        prompts,
        reason: `maximum continuations reached: ${options.maxContinuations}`,
        state,
        terminalState: "max_continuations_reached",
      })
    : Option.none();

const renderGoalContinuationPrompt = (state: PipelineGoalState): string =>
  renderContinuationPrompt({
    exactNextRequirement: exactNextRequirement(state),
    state,
  });

const noProgressResult = (state: PipelineGoalState, prompts: string[]): GoalLoopResult => {
  const reason = "same failure repeated without new changed files or evidence";
  return {
    attempts: state.continuationAttempts.length,
    prompts,
    reason,
    state: markGoalStateBlocked(state, reason),
    terminalState: "no_progress_detected",
  };
};

export const createGoalContinuationLaunchPlan = (input: {
  config: PipelineConfig;
  nodeId?: string;
  profileId?: string;
  prompt: string;
  worktreePath: string;
}): RunnerLaunchPlan =>
  createRunnerLaunchPlan(input.config, {
    nodeId: input.nodeId ?? "goal-continuation",
    profileId: input.profileId ?? "moka-code-writer",
    prompt: input.prompt,
    worktreePath: input.worktreePath,
  });

type TerminalResultHandler = (state: PipelineGoalState, prompts: string[]) => Option.Option<GoalLoopResult>;

const nullTerminalResult = (): Option.Option<GoalLoopResult> => Option.none();

const missingEvidenceResult = (state: PipelineGoalState, prompts: string[]): GoalLoopResult => {
  const reason = "missing deterministic verifier or acceptance evidence";
  return {
    attempts: state.continuationAttempts.length,
    prompts,
    reason,
    state: markGoalStateBlocked(state, reason),
    terminalState: "blocked",
  };
};

const passResult = (state: PipelineGoalState, prompts: string[]): GoalLoopResult => {
  if (!goalStateCompletionEvidence(state).passed) {
    return missingEvidenceResult(state, prompts);
  }
  return {
    attempts: state.continuationAttempts.length,
    prompts,
    reason: "goal passed",
    state,
    terminalState: "passed",
  };
};

const blockedResult = (state: PipelineGoalState, prompts: string[]): GoalLoopResult => ({
  attempts: state.continuationAttempts.length,
  prompts,
  reason: state.blockedReasons.at(-1) ?? "goal blocked",
  state,
  terminalState: "blocked",
});

const cancelledResult = (state: PipelineGoalState, prompts: string[], reason: string): GoalLoopResult => ({
  attempts: state.continuationAttempts.length,
  prompts,
  reason,
  state,
  terminalState: "cancelled",
});

const cancellationTerminalResult = (
  state: PipelineGoalState,
  prompts: string[],
  shouldCancel?: () => boolean,
): Option.Option<GoalLoopResult> => {
  if (shouldCancel?.() === true) {
    return Option.some(cancelledResult(state, prompts, "goal loop cancelled"));
  }
  return Option.none();
};

const TERMINAL_RESULT_HANDLERS: Partial<
  Record<NonNullable<PipelineGoalState["terminalOutcome"]>, TerminalResultHandler>
> = {
  BLOCKED: (state, prompts) => Option.some(blockedResult(state, prompts)),
  CANCELLED: (state, prompts) => Option.some(cancelledResult(state, prompts, "goal cancelled")),
  PASS: (state, prompts) => Option.some(passResult(state, prompts)),
};

const terminalResultHandler = (outcome: PipelineGoalState["terminalOutcome"]): TerminalResultHandler =>
  TERMINAL_RESULT_HANDLERS[outcome ?? "FAIL"] ?? nullTerminalResult;

const outcomeTerminalResult = (state: PipelineGoalState, prompts: string[]): Option.Option<GoalLoopResult> =>
  terminalResultHandler(state.terminalOutcome)(state, prompts);

const terminalResult = (
  state: PipelineGoalState,
  prompts: string[],
  shouldCancel?: () => boolean,
): Option.Option<GoalLoopResult> => {
  const cancellation = cancellationTerminalResult(state, prompts, shouldCancel);
  return Option.isSome(cancellation) ? cancellation : outcomeTerminalResult(state, prompts);
};

const latestGateReason = (latestGate?: PipelineGoalState["gateFailures"][number]): Option.Option<string> => {
  if (latestGate === undefined) {
    return Option.none();
  }
  return Option.some(latestGate.reason ?? `failed gate ${latestGate.gateId}`);
};

const verifierReason = (state: PipelineGoalState): Option.Option<string> => {
  if (state.verifier.verdict !== "FAIL") {
    return Option.none();
  }
  return Option.some(state.verifier.reason ?? "verifier requested remediation");
};

const continuationReason = (state: PipelineGoalState): string => {
  const latestGate = state.gateFailures.at(-1);
  const gateReason = latestGateReason(latestGate);
  if (Option.isSome(gateReason)) {
    return gateReason.value;
  }
  const verifierFailureReason = verifierReason(state);
  return Option.isSome(verifierFailureReason) ? verifierFailureReason.value : "goal incomplete";
};

const promptPathField = (value: Option.Option<string>): { promptPath?: string } =>
  Option.isSome(value) && value.value.length > 0 ? { promptPath: value.value } : {};

const verifierNodeIdField = (value: Option.Option<string>): { verifierNodeId?: string } =>
  Option.isSome(value) && value.value.length > 0 ? { verifierNodeId: value.value } : {};

const stateWithContinuationAttempt = (state: PipelineGoalState, promptPath: Option.Option<string>): PipelineGoalState =>
  recordGoalStateContinuationAttempt(state, {
    ...promptPathField(promptPath),
    reason: continuationReason(state),
    ...verifierNodeIdField(Option.fromNullishOr(state.verifier.nodeId)),
  });

const continuationInput = (
  attempt: number,
  prompt: string,
  state: PipelineGoalState,
  promptPath: Option.Option<string>,
): GoalLoopContinuationInputType => ({
  attempt,
  prompt,
  ...promptPathField(promptPath),
  state: stateWithContinuationAttempt(state, promptPath),
});

const runGoalContinuationEffect = (
  options: GoalLoopOptions,
  state: PipelineGoalState,
  prompts: string[],
): Effect.Effect<PipelineGoalState, unknown, GoalLoopService> =>
  Effect.gen(function* effectBody() {
    const service = yield* GoalLoopService;
    const attempt = state.continuationAttempts.length + 1;
    const prompt = renderGoalContinuationPrompt(state);
    const promptPath = yield* service.writePrompt(options.writePrompt, attempt, prompt, state);
    prompts.push(prompt);
    return yield* service.runContinuation(
      options.runContinuation,
      continuationInput(attempt, prompt, state, promptPath),
    );
  });

interface ProgressSignature {
  changedFiles: string;
  evidence: string;
  failure: string;
}

const progressSignature = (state: PipelineGoalState): ProgressSignature => {
  const failedAcceptance = state.acceptance.filter((item) => item.verdict === "FAIL");
  return {
    changedFiles: state.changedFiles.join("\0"),
    evidence: [
      ...state.gateFailures.flatMap((gate) => gate.evidence),
      ...state.verifier.evidence,
      ...failedAcceptance.flatMap((item) => item.evidence),
    ].join("\0"),
    failure: goalStateFailureSignature(state),
  };
};

const isNoProgress = (before: ProgressSignature, after: ProgressSignature): boolean =>
  before.failure.length > 0 &&
  before.failure === after.failure &&
  before.changedFiles === after.changedFiles &&
  before.evidence === after.evidence;

const postContinuationResult = (
  nextState: PipelineGoalState,
  beforeProgress: ProgressSignature,
  prompts: string[],
  shouldCancel?: () => boolean,
): Option.Option<GoalLoopResult> => {
  const terminal = terminalResult(nextState, prompts, shouldCancel);
  if (Option.isSome(terminal)) {
    return terminal;
  }
  return isNoProgress(beforeProgress, progressSignature(nextState))
    ? Option.some(noProgressResult(nextState, prompts))
    : Option.none();
};

const continueGoalLoop = (
  options: GoalLoopOptions,
  state: PipelineGoalState,
  prompts: string[],
): Effect.Effect<GoalLoopResult, unknown, GoalLoopService> =>
  Effect.gen(function* effectBody() {
    const terminal = terminalResult(state, prompts, options.shouldCancel);
    if (Option.isSome(terminal)) {
      return terminal.value;
    }
    const maxContinuations = maxContinuationsResult(state, prompts, options);
    if (Option.isSome(maxContinuations)) {
      return maxContinuations.value;
    }
    const beforeProgress = progressSignature(state);
    const nextState = yield* runGoalContinuationEffect(options, state, prompts);
    const postContinuation = postContinuationResult(nextState, beforeProgress, prompts, options.shouldCancel);
    return Option.isSome(postContinuation)
      ? postContinuation.value
      : yield* continueGoalLoop(options, nextState, prompts);
  });

const runBoundedGoalLoopEffect = (options: GoalLoopOptions): Effect.Effect<GoalLoopResult, unknown, GoalLoopService> =>
  Effect.flatMap(validateGoalLoopOptions(options), () => continueGoalLoop(options, options.initialState, []));

export const runBoundedGoalLoop = async (options: GoalLoopOptions): Promise<GoalLoopResult> =>
  await Effect.runPromise(Effect.provide(runBoundedGoalLoopEffect(options), GoalLoopServiceLive));
