import { Effect } from "effect";

import type { PlannedWorkflowNode } from "../../planning/compile";
import type { AgentResult, RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
import type { RuntimeContext } from "../contracts";
import { emit, emitAgentFinish, emitAgentStart } from "../events";
import { AgentNodeRuntimeService } from "../services/agent-node-runtime-service";

export interface ModelAttemptOutcome {
  plan: RunnerLaunchPlan;
  result: AgentResult;
}

const agentOutputRecorder =
  (context: RuntimeContext, node: PlannedWorkflowNode, attempt: number) =>
  (event: { chunk: string; stream: "stderr" | "stdout" }) => {
    if (event.stream !== "stdout") {
      return;
    }
    emit(context, {
      attempt,
      format: "text",
      nodeId: node.id,
      output: event.chunk,
      ...(node.profile === undefined || node.profile.length === 0 ? {} : { profile: node.profile }),
      type: "node.output.recorded",
    });
  };

export const runModelAttemptEffect = (inputs: {
  attempt: number;
  context: RuntimeContext;
  model?: string;
  node: PlannedWorkflowNode;
  profileId: string;
  prompt: string;
}): Effect.Effect<ModelAttemptOutcome, unknown, AgentNodeRuntimeService> =>
  Effect.gen(function* effectBody() {
    const { attempt, context, model, node, profileId, prompt } = inputs;
    const service = yield* AgentNodeRuntimeService;
    const plan = createRunnerLaunchPlan(context.config, {
      model,
      nodeId: node.id,
      profileId,
      prompt,
      reasoningEffort: node.reasoning_effort,
      worktreePath: context.worktreePath,
    });
    if (node.timeoutMs !== undefined && node.timeoutMs !== 0) {
      plan.timeoutMs = node.timeoutMs;
    }
    context.agentInvocations.push(plan);
    emitAgentStart(context, plan, attempt);
    const result = yield* service.executeRunner(context.executor, plan, {
      onOutput: agentOutputRecorder(context, node, attempt),
      signal: context.signal,
    });
    emitAgentFinish(context, plan, attempt, result);
    if (result.sessionId !== undefined && result.sessionId.length > 0) {
      context.nodeStateStore.recordSessionId(node.id, result.sessionId);
    }
    return { plan, result };
  });
