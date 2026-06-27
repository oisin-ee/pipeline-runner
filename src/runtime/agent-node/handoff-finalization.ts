import { Effect } from "effect";
import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
import type { RuntimeContext } from "../contracts";
import { emitAgentFinish, emitAgentStart } from "../events";
import {
  handoffFinalizerPrompt,
  type NodeHandoff,
  parseHandoff,
  synthesizeMinimalHandoff,
} from "../handoff";
import { AgentNodeRuntimeService } from "../services/agent-node-runtime-service";
import { normalizeAgentOutput } from "./output-finalization";

export function maybeDeriveHandoffEffect(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number
): Effect.Effect<NodeHandoff | undefined, unknown, AgentNodeRuntimeService> {
  if (!context.config.context_handoff?.enabled) {
    return Effect.succeed(undefined);
  }
  const handoff = parseHandoff(rawOutput);
  return handoff
    ? Effect.succeed(handoff)
    : runHandoffFinalizerEffect(context, node, rawOutput, attempt);
}

function runHandoffFinalizerEffect(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number
): Effect.Effect<NodeHandoff, never, AgentNodeRuntimeService> {
  return Effect.gen(function* () {
    const runner = profileRunner(context, node);
    if (!(runner && rawOutput.trim())) {
      return synthesizeMinimalHandoff(rawOutput);
    }
    const plan = createHandoffFinalizerPlan(context, node, runner, rawOutput);
    context.agentInvocations.push(plan);
    emitAgentStart(context, plan, attempt);
    const service = yield* AgentNodeRuntimeService;
    const result = yield* service.executeRunner(context.executor, plan, {
      signal: context.signal,
    });
    emitAgentFinish(context, plan, attempt, result);
    const normalized = normalizeAgentOutput(plan, result.stdout);
    return (
      parseHandoff(normalized.output) ?? synthesizeMinimalHandoff(rawOutput)
    );
  }).pipe(
    Effect.catch(() => Effect.succeed(synthesizeMinimalHandoff(rawOutput)))
  );
}

function profileRunner(
  context: RuntimeContext,
  node: PlannedWorkflowNode
): string | undefined {
  return node.profile
    ? context.config.profiles[node.profile]?.runner
    : undefined;
}

function createHandoffFinalizerPlan(
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  runner: string,
  rawOutput: string
): RunnerLaunchPlan {
  const finalizerProfileId = `${node.id}:handoff`;
  const finalizerConfig: PipelineConfig = {
    ...context.config,
    profiles: {
      ...context.config.profiles,
      [finalizerProfileId]: {
        filesystem: { mode: "read-only" },
        instructions: {
          inline: "Summarize the agent output into a NodeHandoff JSON.",
        },
        network: { mode: "disabled" },
        output: { format: "text" },
        runner,
        tools: [],
      },
    },
  };
  const model = context.config.context_handoff?.model;
  return createRunnerLaunchPlan(finalizerConfig, {
    nodeId: finalizerProfileId,
    profileId: finalizerProfileId,
    prompt: handoffFinalizerPrompt(rawOutput),
    worktreePath: context.worktreePath,
    ...(model ? { model } : {}),
  });
}
