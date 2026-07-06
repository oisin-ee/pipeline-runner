import { Effect, Option } from "effect";

import type { PipelineConfig } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { RunnerLaunchPlan } from "../../runner";
import { createRunnerLaunchPlan } from "../../runner";
import type { RuntimeContext } from "../contracts";
import { emitAgentFinish, emitAgentStart } from "../events";
import { handoffFinalizerPrompt, parseHandoff, synthesizeMinimalHandoff } from "../handoff";
import type { NodeHandoff } from "../handoff";
import { AgentNodeRuntimeService } from "../services/agent-node-runtime-service";
import { normalizeAgentOutput } from "./output-finalization";

const NO_HANDOFF: Option.Option<NodeHandoff> = Option.none();

const profileRunner = (context: RuntimeContext, node: PlannedWorkflowNode): Option.Option<string> =>
  node.profile === undefined || node.profile.length === 0
    ? Option.none()
    : Option.fromUndefinedOr(context.config.profiles[node.profile]?.runner);

const createHandoffFinalizerPlan = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  runner: string,
  rawOutput: string,
): RunnerLaunchPlan => {
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
    ...(model === undefined || model.length === 0 ? {} : { model }),
  });
};

const runHandoffFinalizerEffect = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number,
): Effect.Effect<NodeHandoff, never, AgentNodeRuntimeService> =>
  Effect.gen(function* effectBody() {
    const runner = profileRunner(context, node);
    const runnerId = Option.getOrUndefined(runner);
    if (runnerId === undefined || rawOutput.trim().length === 0) {
      return synthesizeMinimalHandoff(rawOutput);
    }
    const plan = createHandoffFinalizerPlan(context, node, runnerId, rawOutput);
    context.agentInvocations.push(plan);
    emitAgentStart(context, plan, attempt);
    const service = yield* AgentNodeRuntimeService;
    const result = yield* service.executeRunner(context.executor, plan, {
      signal: context.signal,
    });
    emitAgentFinish(context, plan, attempt, result);
    const normalized = normalizeAgentOutput(plan, result.stdout);
    const handoff = parseHandoff(normalized.output);
    return Option.getOrElse(handoff, () => synthesizeMinimalHandoff(rawOutput));
  }).pipe(Effect.catch(() => Effect.succeed(synthesizeMinimalHandoff(rawOutput))));

export const maybeDeriveHandoffEffect = (
  context: RuntimeContext,
  node: PlannedWorkflowNode,
  rawOutput: string,
  attempt: number,
): Effect.Effect<Option.Option<NodeHandoff>, unknown, AgentNodeRuntimeService> => {
  if (context.config.context_handoff?.enabled !== true) {
    return Effect.succeed(NO_HANDOFF);
  }
  const handoff = parseHandoff(rawOutput);
  return Option.isNone(handoff)
    ? runHandoffFinalizerEffect(context, node, rawOutput, attempt).pipe(Effect.map(Option.some))
    : Effect.succeed(handoff);
};
