import type { RunEffort, RunMode, RunTarget } from "../run-control/contracts";
import type {
  LocalRuntimeExecution,
  RemoteSubmitExecution,
  RunResolution,
  RunResolverFlags,
} from "./run-resolver";

export interface RunCommandCall {
  readonly descriptionParts: string[];
  readonly flags: RunResolverFlags;
  readonly resolution: RunResolution;
  readonly task: string;
  readonly ticketId?: string;
}

export type RunCommand = (call: RunCommandCall) => Promise<void> | void;

export interface ResolvedRunControlOptions {
  readonly effort: RunEffort;
  readonly mode: RunMode;
  readonly target: RunTarget;
}

export interface LocalRunDispatchInput {
  readonly execution: LocalRuntimeExecution;
  readonly runControl: ResolvedRunControlOptions;
  readonly task: string;
}

export interface RemoteSubmitDispatchInput {
  readonly descriptionParts: string[];
  readonly execution: RemoteSubmitExecution;
}

export interface RunCommandDispatchDependencies {
  readonly runCommand?: RunCommand;
  readonly runDetached: (input: LocalRunDispatchInput) => Promise<void>;
  readonly runLocal: (input: LocalRunDispatchInput) => Promise<void>;
  readonly runRemoteSubmit: (input: RemoteSubmitDispatchInput) => Promise<void>;
}

const localRunDispatchInput = (
  call: RunCommandCall,
  execution: LocalRuntimeExecution
): LocalRunDispatchInput => {
  const { resolution, task } = call;
  return {
    execution,
    runControl: {
      effort: resolution.effort,
      mode: resolution.mode === "read" ? "read-only" : "write",
      target: resolution.target,
    },
    task,
  };
};

const dispatchLocalMokaRunCommand = async (
  call: RunCommandCall,
  execution: LocalRuntimeExecution,
  dependencies: RunCommandDispatchDependencies
): Promise<void> => {
  const localDispatchInput = localRunDispatchInput(call, execution);
  if (call.flags.detach === true) {
    await dependencies.runDetached(localDispatchInput);
    return;
  }
  await dependencies.runLocal(localDispatchInput);
};

const dispatchResolvedMokaRunCommand = async (
  call: RunCommandCall,
  dependencies: RunCommandDispatchDependencies
): Promise<void> => {
  const { resolution } = call;
  const { execution } = resolution;
  if (execution.kind === "remote-submit") {
    await dependencies.runRemoteSubmit({
      descriptionParts: call.descriptionParts,
      execution,
    });
    return;
  }
  await dispatchLocalMokaRunCommand(call, execution, dependencies);
};

export const dispatchMokaRunCommand = async (
  call: RunCommandCall,
  dependencies: RunCommandDispatchDependencies
): Promise<void> => {
  if (dependencies.runCommand) {
    await dependencies.runCommand(call);
    return;
  }
  await dispatchResolvedMokaRunCommand(call, dependencies);
};
