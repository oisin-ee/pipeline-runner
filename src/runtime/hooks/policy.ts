import { Option } from "effect";

import type { HookEvent } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type {
  HookBinding,
  HookFunctionSpec,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";
import { runtimeHookFailure } from "./results";

const bindingFilterMatches = (
  filter: readonly [Option.Option<string>, Option.Option<string>]
): boolean => {
  const [expected, actual] = filter;
  return Option.match(expected, {
    onNone: () => true,
    onSome: (value) =>
      Option.match(actual, {
        onNone: () => false,
        onSome: (actualValue) => actualValue === value,
      }),
  });
};

const hookBindingMatchesContext = (
  binding: HookBinding,
  workflowId: string,
  nodeId?: string,
  gateId?: string
): boolean => {
  const { where } = binding;
  const filters: (readonly [Option.Option<string>, Option.Option<string>])[] = [
    [Option.fromUndefinedOr(where?.workflow), Option.some(workflowId)],
    [Option.fromUndefinedOr(where?.node), Option.fromUndefinedOr(nodeId)],
    [Option.fromUndefinedOr(where?.gate), Option.fromUndefinedOr(gateId)],
  ];
  return filters.every(bindingFilterMatches);
};

export const hookBindingsForContext = (
  context: RuntimeContext,
  event: HookEvent,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookBinding[] =>
  (context.config.hooks.on[event] ?? []).filter((binding) =>
    hookBindingMatchesContext(binding, context.workflowId, node?.id, gateId)
  );

export const moduleHookPolicyFailure = (
  binding: HookBinding,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Option.Option<RuntimeFailure> => {
  if (context.config.hooks.policy?.modules === "deny") {
    return Option.some(
      runtimeHookFailure(
        binding,
        `hook '${binding.id}' failed`,
        ["module hooks are disabled"],
        node
      )
    );
  }
  return Option.none();
};

export const commandHookFailure = (
  binding: HookBinding,
  evidence: string,
  node?: PlannedWorkflowNode
): RuntimeFailure =>
  runtimeHookFailure(binding, `hook '${binding.id}' failed`, [evidence], node);

const commandHooksDisabled = (context: RuntimeContext): boolean =>
  !context.hookPolicy.allowCommandHooks ||
  context.config.hooks.policy?.commands === "deny";

const untrustedCommandHookDisabled = (
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  context: RuntimeContext
): boolean => {
  const commandPolicy = context.config.hooks.policy?.commands;
  return (
    hookFunction.trusted !== true &&
    (commandPolicy === "trusted-only" ||
      !context.hookPolicy.allowUntrustedCommandHooks)
  );
};

export const commandHookPolicyFailure = (
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  binding: HookBinding,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): Option.Option<RuntimeFailure> => {
  if (commandHooksDisabled(context)) {
    return Option.some(
      commandHookFailure(binding, "command hooks are disabled", node)
    );
  }
  if (untrustedCommandHookDisabled(hookFunction, context)) {
    return Option.some(
      commandHookFailure(binding, "command hook is not trusted", node)
    );
  }
  return Option.none();
};
