import type { PipelineConfig } from "../../config";
import { createRunnerLaunchPlan, type RunnerLaunchPlan } from "../../runner";
import {
  goalStateCompletionEvidence,
  goalStateFailureSignature,
  markGoalStateBlocked,
  type PipelineGoalState,
  recordGoalStateContinuationAttempt,
} from "../goal-state/goal-state";
import {
  exactNextRequirement,
  renderContinuationPrompt,
} from "./continuation-prompt";

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

export interface GoalLoopResult {
  attempts: number;
  prompts: string[];
  reason: string;
  state: PipelineGoalState;
  terminalState: GoalLoopTerminalState;
}

export async function runBoundedGoalLoop(
  options: GoalLoopOptions
): Promise<GoalLoopResult> {
  if (
    !Number.isInteger(options.maxContinuations) ||
    options.maxContinuations < 0
  ) {
    throw new Error("maxContinuations must be a non-negative integer");
  }
  let state = options.initialState;
  const prompts: string[] = [];
  for (;;) {
    const terminal = terminalResult(state, prompts, options.shouldCancel);
    if (terminal) {
      return terminal;
    }
    const maxContinuations = maxContinuationsResult(state, prompts, options);
    if (maxContinuations) {
      return maxContinuations;
    }

    const beforeProgress = progressSignature(state);
    const nextState = await runGoalContinuation(options, state, prompts);
    const postContinuation = postContinuationResult(
      nextState,
      beforeProgress,
      prompts,
      options.shouldCancel
    );
    if (postContinuation) {
      return postContinuation;
    }
    state = nextState;
  }
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

async function runGoalContinuation(
  options: GoalLoopOptions,
  state: PipelineGoalState,
  prompts: string[]
): Promise<PipelineGoalState> {
  const attempt = state.continuationAttempts.length + 1;
  const prompt = renderContinuationPrompt({
    exactNextRequirement: exactNextRequirement(state),
    state,
  });
  const promptPath = await options.writePrompt?.(attempt, prompt, state);
  prompts.push(prompt);
  return options.runContinuation({
    attempt,
    prompt,
    ...(promptPath ? { promptPath } : {}),
    state: stateWithContinuationAttempt(state, promptPath),
  });
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
  if (shouldCancel?.()) {
    return {
      attempts: state.continuationAttempts.length,
      prompts,
      reason: "goal loop cancelled",
      state,
      terminalState: "cancelled",
    };
  }
  switch (state.terminalOutcome) {
    case "PASS":
      if (!goalStateCompletionEvidence(state).passed) {
        return {
          attempts: state.continuationAttempts.length,
          prompts,
          reason: "missing deterministic verifier or acceptance evidence",
          state: markGoalStateBlocked(
            state,
            "missing deterministic verifier or acceptance evidence"
          ),
          terminalState: "blocked",
        };
      }
      return {
        attempts: state.continuationAttempts.length,
        prompts,
        reason: "goal passed",
        state,
        terminalState: "passed",
      };
    case "BLOCKED":
      return {
        attempts: state.continuationAttempts.length,
        prompts,
        reason: state.blockedReasons.at(-1) ?? "goal blocked",
        state,
        terminalState: "blocked",
      };
    case "CANCELLED":
      return {
        attempts: state.continuationAttempts.length,
        prompts,
        reason: "goal cancelled",
        state,
        terminalState: "cancelled",
      };
    default:
      return null;
  }
}

function continuationReason(state: PipelineGoalState): string {
  const latestGate = state.gateFailures.at(-1);
  if (latestGate) {
    return latestGate.reason ?? `failed gate ${latestGate.gateId}`;
  }
  if (state.verifier.verdict === "FAIL") {
    return state.verifier.reason ?? "verifier requested remediation";
  }
  return "goal incomplete";
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
