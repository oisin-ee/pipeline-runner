// fallow-ignore-file unused-file
import { Effect } from "effect";
import type { PipelineConfig } from "../../config";
import type { RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
import {
  goalStateCompletionEvidence,
  goalStateFailureSignature,
  markGoalStateBlocked,
  type PipelineGoalState,
  recordGoalStateContinuationAttempt,
} from "../goal-state/goal-state";
import {
  type GoalLoopContinuationInput as GoalLoopContinuationInputType,
  type GoalLoopOptions,
  type GoalLoopResult,
  GoalLoopService,
  GoalLoopServiceLive,
} from "../services/goal-loop-service";
import {
  exactNextRequirement,
  renderContinuationPrompt,
} from "./continuation-prompt";

export type {
  GoalLoopContinuationInput,
  GoalLoopOptions,
  GoalLoopResult,
  GoalLoopTerminalState,
} from "../services/goal-loop-service";

export function runBoundedGoalLoop(
  options: GoalLoopOptions
): Promise<GoalLoopResult> {
  return Effect.runPromise(
    Effect.provide(runBoundedGoalLoopEffect(options), GoalLoopServiceLive)
  );
}

function runBoundedGoalLoopEffect(
  options: GoalLoopOptions
): Effect.Effect<GoalLoopResult, unknown, GoalLoopService> {
  return Effect.flatMap(validateGoalLoopOptions(options), () =>
    continueGoalLoop(options, options.initialState, [])
  );
}

function validateGoalLoopOptions(
  options: GoalLoopOptions
): Effect.Effect<GoalLoopOptions, unknown> {
  return Effect.try({
    catch: (error) => error,
    try: () => assertValidMaxContinuations(options),
  });
}

function assertValidMaxContinuations(
  options: GoalLoopOptions
): GoalLoopOptions {
  if (isValidMaxContinuations(options.maxContinuations)) {
    return options;
  }
  throw new Error("maxContinuations must be a non-negative integer");
}

function isValidMaxContinuations(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function continueGoalLoop(
  options: GoalLoopOptions,
  state: PipelineGoalState,
  prompts: string[]
): Effect.Effect<GoalLoopResult, unknown, GoalLoopService> {
  return Effect.gen(function* () {
    const terminal = terminalResult(state, prompts, options.shouldCancel);
    if (terminal) {
      return terminal;
    }
    const maxContinuations = maxContinuationsResult(state, prompts, options);
    if (maxContinuations) {
      return maxContinuations;
    }
    const beforeProgress = progressSignature(state);
    const nextState = yield* runGoalContinuationEffect(options, state, prompts);
    const postContinuation = postContinuationResult(
      nextState,
      beforeProgress,
      prompts,
      options.shouldCancel
    );
    return (
      postContinuation ?? (yield* continueGoalLoop(options, nextState, prompts))
    );
  });
}

function maxContinuationsResult(
  state: PipelineGoalState,
  prompts: string[],
  options: GoalLoopOptions
): GoalLoopResult | null {
  return state.continuationAttempts.length >= options.maxContinuations
    ? {
        attempts: state.continuationAttempts.length,
        prompts,
        reason: `maximum continuations reached: ${options.maxContinuations}`,
        state,
        terminalState: "max_continuations_reached",
      }
    : null;
}

function runGoalContinuationEffect(
  options: GoalLoopOptions,
  state: PipelineGoalState,
  prompts: string[]
): Effect.Effect<PipelineGoalState, unknown, GoalLoopService> {
  return Effect.gen(function* () {
    const service = yield* GoalLoopService;
    const attempt = state.continuationAttempts.length + 1;
    const prompt = renderGoalContinuationPrompt(state);
    const promptPath = yield* service.writePrompt(
      options.writePrompt,
      attempt,
      prompt,
      state
    );
    prompts.push(prompt);
    return yield* service.runContinuation(
      options.runContinuation,
      continuationInput(attempt, prompt, promptPath, state)
    );
  });
}

function renderGoalContinuationPrompt(state: PipelineGoalState): string {
  return renderContinuationPrompt({
    exactNextRequirement: exactNextRequirement(state),
    state,
  });
}

function continuationInput(
  attempt: number,
  prompt: string,
  promptPath: string | undefined,
  state: PipelineGoalState
): GoalLoopContinuationInputType {
  return {
    attempt,
    prompt,
    ...(promptPath ? { promptPath } : {}),
    state: stateWithContinuationAttempt(state, promptPath),
  };
}

function stateWithContinuationAttempt(
  state: PipelineGoalState,
  promptPath: string | undefined
): PipelineGoalState {
  return recordGoalStateContinuationAttempt(state, {
    ...(promptPath ? { promptPath } : {}),
    reason: continuationReason(state),
    ...(state.verifier.nodeId ? { verifierNodeId: state.verifier.nodeId } : {}),
  });
}

function postContinuationResult(
  nextState: PipelineGoalState,
  beforeProgress: ProgressSignature,
  prompts: string[],
  shouldCancel: (() => boolean) | undefined
): GoalLoopResult | null {
  const terminal = terminalResult(nextState, prompts, shouldCancel);
  if (terminal) {
    return terminal;
  }
  return isNoProgress(beforeProgress, progressSignature(nextState))
    ? noProgressResult(nextState, prompts)
    : null;
}

function noProgressResult(
  state: PipelineGoalState,
  prompts: string[]
): GoalLoopResult {
  const reason = "same failure repeated without new changed files or evidence";
  return {
    attempts: state.continuationAttempts.length,
    prompts,
    reason,
    state: markGoalStateBlocked(state, reason),
    terminalState: "no_progress_detected",
  };
}

export function createGoalContinuationLaunchPlan(input: {
  config: PipelineConfig;
  nodeId?: string;
  profileId?: string;
  prompt: string;
  worktreePath: string;
}): RunnerLaunchPlan {
  return createRunnerLaunchPlan(input.config, {
    nodeId: input.nodeId ?? "goal-continuation",
    profileId: input.profileId ?? "moka-code-writer",
    prompt: input.prompt,
    worktreePath: input.worktreePath,
  });
}

function terminalResult(
  state: PipelineGoalState,
  prompts: string[],
  shouldCancel: (() => boolean) | undefined
): GoalLoopResult | null {
  return (
    cancellationTerminalResult(state, prompts, shouldCancel) ??
    outcomeTerminalResult(state, prompts)
  );
}

function cancellationTerminalResult(
  state: PipelineGoalState,
  prompts: string[],
  shouldCancel: (() => boolean) | undefined
): GoalLoopResult | null {
  if (shouldCancel?.()) {
    return cancelledResult(state, prompts, "goal loop cancelled");
  }
  return null;
}

function outcomeTerminalResult(
  state: PipelineGoalState,
  prompts: string[]
): GoalLoopResult | null {
  return terminalResultHandler(state.terminalOutcome)(state, prompts);
}

type TerminalResultHandler = (
  state: PipelineGoalState,
  prompts: string[]
) => GoalLoopResult | null;

const TERMINAL_RESULT_HANDLERS: Partial<
  Record<
    NonNullable<PipelineGoalState["terminalOutcome"]>,
    TerminalResultHandler
  >
> = {
  BLOCKED: blockedResult,
  CANCELLED: (state, prompts) =>
    cancelledResult(state, prompts, "goal cancelled"),
  PASS: passResult,
};

function terminalResultHandler(
  outcome: PipelineGoalState["terminalOutcome"]
): TerminalResultHandler {
  return TERMINAL_RESULT_HANDLERS[outcome ?? "FAIL"] ?? nullTerminalResult;
}

function nullTerminalResult(): null {
  return null;
}

function passResult(
  state: PipelineGoalState,
  prompts: string[]
): GoalLoopResult {
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
}

function missingEvidenceResult(
  state: PipelineGoalState,
  prompts: string[]
): GoalLoopResult {
  const reason = "missing deterministic verifier or acceptance evidence";
  return {
    attempts: state.continuationAttempts.length,
    prompts,
    reason,
    state: markGoalStateBlocked(state, reason),
    terminalState: "blocked",
  };
}

function blockedResult(
  state: PipelineGoalState,
  prompts: string[]
): GoalLoopResult {
  return {
    attempts: state.continuationAttempts.length,
    prompts,
    reason: state.blockedReasons.at(-1) ?? "goal blocked",
    state,
    terminalState: "blocked",
  };
}

function cancelledResult(
  state: PipelineGoalState,
  prompts: string[],
  reason: string
): GoalLoopResult {
  return {
    attempts: state.continuationAttempts.length,
    prompts,
    reason,
    state,
    terminalState: "cancelled",
  };
}

function continuationReason(state: PipelineGoalState): string {
  const latestGate = state.gateFailures.at(-1);
  return (
    latestGateReason(latestGate) ?? verifierReason(state) ?? "goal incomplete"
  );
}

function latestGateReason(
  latestGate: PipelineGoalState["gateFailures"][number] | undefined
): string | null {
  if (!latestGate) {
    return null;
  }
  return latestGate.reason ?? `failed gate ${latestGate.gateId}`;
}

function verifierReason(state: PipelineGoalState): string | null {
  if (state.verifier.verdict !== "FAIL") {
    return null;
  }
  return state.verifier.reason ?? "verifier requested remediation";
}

interface ProgressSignature {
  changedFiles: string;
  evidence: string;
  failure: string;
}

function progressSignature(state: PipelineGoalState): ProgressSignature {
  const failedAcceptance = state.acceptance.filter(
    (item) => item.verdict === "FAIL"
  );
  return {
    changedFiles: state.changedFiles.join("\0"),
    evidence: [
      ...state.gateFailures.flatMap((gate) => gate.evidence),
      ...state.verifier.evidence,
      ...failedAcceptance.flatMap((item) => item.evidence),
    ].join("\0"),
    failure: goalStateFailureSignature(state),
  };
}

function isNoProgress(
  before: ProgressSignature,
  after: ProgressSignature
): boolean {
  return (
    before.failure.length > 0 &&
    before.failure === after.failure &&
    before.changedFiles === after.changedFiles &&
    before.evidence === after.evidence
  );
}
