import { jsonLineValues } from "../json-line-values";
import type { AgentResult, RunnerLaunchPlan } from "../runner";
import { isRecord } from "../safe-json";

export interface RuntimeLaunchCommand {
  args: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface RuntimeSessionMetadata {
  adapterId: string;
  continuationApi: "unavailable";
  nodeId: string;
  outputFormat: string;
  pluginEvents: "project-local";
  profileId?: string;
  runnerId: string;
  sessionInspectionApi: "unavailable";
  worktreePath: string;
}

export interface RuntimeOutputCandidate {
  evidence: string;
  output: string;
}

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

export const opencodeCliRuntimeAdapter: RuntimeCapabilityAdapter = {
  continuation() {
    return Promise.reject(
      new Error(
        "OpenCode CLI runtime adapter does not expose native continuation yet"
      )
    );
  },

  id: "opencode-cli-subprocess",

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
    if (!latest) {
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
      continuationApi: "unavailable",
      nodeId: plan.nodeId,
      outputFormat: plan.outputFormat,
      pluginEvents: "project-local",
      profileId: plan.profileId,
      runnerId: plan.runnerId,
      sessionInspectionApi: "unavailable",
      worktreePath: plan.cwd,
    };
  },
};

function assertOpenCodePlan(plan: RunnerLaunchPlan): void {
  if (plan.type !== "opencode") {
    throw new Error(
      `OpenCode runtime adapter cannot handle runner type '${plan.type}'`
    );
  }
}

function opencodeTextPart(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return;
  }
  const part = value.part;
  if (isRecord(part) && part.type === "text") {
    return typeof part.text === "string" ? part.text : undefined;
  }
}
