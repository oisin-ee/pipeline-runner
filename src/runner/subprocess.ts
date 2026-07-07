import { rmSync } from "node:fs";

import { fromNullishOr, match as matchOption, none } from "effect/Option";
import type { Option } from "effect/Option";
import { execa } from "execa";

import type {
  AgentResult,
  RunnerExecutionOptions,
  RunnerLaunchPlan,
} from "../runner";
import { createProtectedPathGuard } from "../runtime/protected-paths/protected-paths";
import { ensureOpencodeGitExcludes } from "./opencode-excludes";
import {
  completedSubprocessResult,
  failedSubprocessResult,
  finalizeLaunchResult,
} from "./subprocess-result";
import { timeoutOption } from "./timeouts";

const prepareLaunchPlanWorktree = (plan: RunnerLaunchPlan): void => {
  if (plan.type === "opencode") {
    ensureOpencodeGitExcludes(plan.cwd);
  }
};

const chunkToString = (chunk: unknown): string =>
  Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);

const streamSubprocessOutput = (
  plan: RunnerLaunchPlan,
  subprocess: {
    stderr?: {
      on?: (event: "data", listener: (chunk: unknown) => void) => void;
    };
    stdout?: {
      on?: (event: "data", listener: (chunk: unknown) => void) => void;
    };
  },
  options: RunnerExecutionOptions
): void => {
  if (!options.onOutput) {
    return;
  }
  subprocess.stdout?.on?.("data", (chunk) => {
    options.onOutput?.({
      chunk: chunkToString(chunk),
      nodeId: plan.nodeId,
      stream: "stdout",
    });
  });
  subprocess.stderr?.on?.("data", (chunk) => {
    options.onOutput?.({
      chunk: chunkToString(chunk),
      nodeId: plan.nodeId,
      stream: "stderr",
    });
  });
};

const executeLaunchPlanSubprocess = async (
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Promise<AgentResult> => {
  try {
    const subprocess = execa(plan.command, plan.args, {
      cancelSignal: options.signal,
      cwd: plan.cwd,
      env: plan.env,
      stdin: "ignore",
      ...timeoutOption(fromNullishOr(plan.timeoutMs)),
    });
    streamSubprocessOutput(plan, subprocess, options);
    return completedSubprocessResult(plan.args, await subprocess);
  } catch (error) {
    return failedSubprocessResult(plan.args, error);
  }
};

const removableOpencodeRuntimeDir = (
  plan: RunnerLaunchPlan
): Option<string> => {
  if (process.env.PIPELINE_KEEP_OPENCODE_RUNTIME_DIR === "1") {
    return none();
  }
  return fromNullishOr(plan.env.PIPELINE_OPENCODE_RUNTIME_DIR);
};

const removeRuntimeDir = (runtimeDir: string): Option<string> => {
  try {
    rmSync(runtimeDir, { force: true, recursive: true });
    return none();
  } catch (error) {
    return fromNullishOr(
      `Failed to remove OpenCode runtime dir ${runtimeDir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const cleanupOpencodeRuntimeDir = (plan: RunnerLaunchPlan): Option<string> => {
  const runtimeDir = removableOpencodeRuntimeDir(plan);
  return matchOption(runtimeDir, {
    onNone: () => none(),
    onSome: removeRuntimeDir,
  });
};

export const runLaunchPlan = async (
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions = {}
): Promise<AgentResult> => {
  prepareLaunchPlanWorktree(plan);
  const guard = createProtectedPathGuard(plan.cwd, plan.protectedPaths);
  const result = await executeLaunchPlanSubprocess(plan, options);
  return finalizeLaunchResult(result, guard, cleanupOpencodeRuntimeDir(plan));
};
