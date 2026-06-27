import { rmSync } from "node:fs";
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

export async function runLaunchPlan(
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions = {}
): Promise<AgentResult> {
  prepareLaunchPlanWorktree(plan);
  const guard = createProtectedPathGuard(plan.cwd, plan.protectedPaths);
  const result = await executeLaunchPlanSubprocess(plan, options);
  const cleanupError = cleanupOpencodeRuntimeDir(plan);
  return finalizeLaunchResult(result, guard, cleanupError);
}

function prepareLaunchPlanWorktree(plan: RunnerLaunchPlan): void {
  if (plan.type === "opencode") {
    ensureOpencodeGitExcludes(plan.cwd);
  }
}

async function executeLaunchPlanSubprocess(
  plan: RunnerLaunchPlan,
  options: RunnerExecutionOptions
): Promise<AgentResult> {
  try {
    const subprocess = execa(plan.command, plan.args, {
      cancelSignal: options.signal,
      cwd: plan.cwd,
      env: plan.env,
      stdin: "ignore",
      ...timeoutOption(plan.timeoutMs),
    });
    streamSubprocessOutput(plan, subprocess, options);
    return completedSubprocessResult(plan.args, await subprocess);
  } catch (err) {
    return failedSubprocessResult(plan.args, err);
  }
}

function streamSubprocessOutput(
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
): void {
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
}

function chunkToString(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
}

function cleanupOpencodeRuntimeDir(plan: RunnerLaunchPlan): string | undefined {
  const runtimeDir = removableOpencodeRuntimeDir(plan);
  if (!runtimeDir) {
    return;
  }
  return removeRuntimeDir(runtimeDir);
}

function removableOpencodeRuntimeDir(
  plan: RunnerLaunchPlan
): string | undefined {
  if (process.env.PIPELINE_KEEP_OPENCODE_RUNTIME_DIR === "1") {
    return;
  }
  return plan.env.PIPELINE_OPENCODE_RUNTIME_DIR;
}

function removeRuntimeDir(runtimeDir: string): string | undefined {
  try {
    rmSync(runtimeDir, { force: true, recursive: true });
    return;
  } catch (err) {
    return `Failed to remove OpenCode runtime dir ${runtimeDir}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}
