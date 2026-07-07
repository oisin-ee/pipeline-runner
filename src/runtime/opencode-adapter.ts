import { Effect, Option } from "effect";

import { jsonLineValues } from "../json-line-values";
import type { AgentResult, RunnerLaunchPlan } from "../runner";
import { isRecord } from "../safe-json";

export interface RuntimeLaunchCommand {
  args: string[];
  command: string;
  cwd: string;
  env: RunnerLaunchPlan["env"];
  timeoutMs?: number;
}

export interface RuntimeSessionMetadata {
  adapterId: string;
  continuationApi: "session-reuse" | "unavailable";
  nodeId: string;
  outputFormat: string;
  pluginEvents: "project-local" | "server-event-stream";
  profileId?: string;
  runnerId: string;
  sessionInspectionApi: "sdk" | "unavailable";
  worktreePath: string;
}

export interface RuntimeOutputCandidate {
  evidence: string;
  output: string;
}

/**
 * Agent-output boundary, layer 3 of 4 (PIPE-74 B3). The result of an adapter
 * normalizing a runner's raw {@link AgentResult} stdout into the agent's text
 * `output` plus the `evidence` lines the harness surfaced. It is still
 * unstructured text — layer 4 (RuntimeStructuredOutput in
 * src/runtime/contracts/contracts.ts) is where this is parsed and
 * schema-validated.
 */
export interface RuntimeNormalizedOutput {
  evidence: string[];
  output: string;
}

export interface RuntimeContinuationRequest {
  prompt: string;
  sessionId: string;
}

export interface RuntimeSessionSnapshot {
  metadata: RuntimeSessionMetadata;
  result?: AgentResult;
}

export interface RuntimeCapabilityAdapter {
  continuation(
    request: RuntimeContinuationRequest
  ): Promise<RuntimeSessionSnapshot>;
  id: string;
  launch(plan: RunnerLaunchPlan): RuntimeLaunchCommand;
  normalizeOutput(stdout: string): RuntimeNormalizedOutput;
  outputCandidates(stdout: string): RuntimeOutputCandidate[];
  sessionMetadata(
    plan: RunnerLaunchPlan,
    result?: AgentResult
  ): RuntimeSessionMetadata;
}

const continuationEffect = (
  request: RuntimeContinuationRequest
): Effect.Effect<RuntimeSessionSnapshot> =>
  Effect.succeed({
    metadata: {
      adapterId: "opencode-sdk",
      continuationApi: "session-reuse",
      nodeId: request.sessionId,
      outputFormat: "text",
      pluginEvents: "server-event-stream",
      runnerId: "opencode",
      sessionInspectionApi: "sdk",
      worktreePath: "",
    },
  });

const assertOpenCodePlan = (plan: RunnerLaunchPlan): void => {
  if (plan.type !== "opencode") {
    throw new Error(
      `OpenCode runtime adapter cannot handle runner type '${plan.type}'`
    );
  }
};

const opencodeTextPart = (value: unknown): Option.Option<string> => {
  if (!isRecord(value)) {
    return Option.none();
  }
  const { part } = value;
  if (isRecord(part) && part.type === "text") {
    return typeof part.text === "string"
      ? Option.some(part.text)
      : Option.none();
  }
  return Option.none();
};

/**
 * Output-parsing seam for opencode runner output. The SDK executor
 * (opencode-session-executor.ts) re-serializes assistant text parts into the
 * same `{ part: { type: "text", text } }` JSONL the legacy CLI emitted, so this
 * parser is transport-agnostic and the structured-output / repair passes work
 * unchanged on top of SDK responses.
 *
 * The session lifecycle, event-stream forwarding, and per-message agent/model
 * selection live in opencode-session-executor.ts + opencode-server.ts; this
 * adapter only normalizes output and reports capabilities.
 */
export const opencodeSdkRuntimeAdapter: RuntimeCapabilityAdapter = {
  async continuation(request) {
    // Continuation reuses the recorded session id at the goal-loop layer; there
    // is no separate native call to make here.
    return await Effect.runPromise(continuationEffect(request));
  },

  id: "opencode-sdk",

  launch(plan) {
    assertOpenCodePlan(plan);
    return {
      args: plan.args,
      command: plan.command,
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: plan.timeoutMs,
    };
  },

  normalizeOutput(stdout) {
    const candidates = this.outputCandidates(stdout);
    const latest = candidates.at(-1);
    if (latest === undefined) {
      return { evidence: [], output: stdout };
    }
    return {
      evidence: [latest.evidence],
      output: latest.output,
    };
  },

  outputCandidates(stdout) {
    return jsonLineValues(stdout, opencodeTextPart).map((output) => ({
      evidence: "normalized runner output from opencode JSON events",
      output,
    }));
  },

  sessionMetadata(plan) {
    assertOpenCodePlan(plan);
    return {
      adapterId: this.id,
      continuationApi: "session-reuse",
      nodeId: plan.nodeId,
      outputFormat: plan.outputFormat,
      pluginEvents: "server-event-stream",
      profileId: plan.profileId,
      runnerId: plan.runnerId,
      sessionInspectionApi: "sdk",
      worktreePath: plan.cwd,
    };
  },
};
