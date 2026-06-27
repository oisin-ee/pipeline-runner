import type { HookEvent } from "../../config";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type {
  HookBinding,
  HookFunctionSpec,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";
import { runtimeHookFailure } from "./results";

export function hookBindingsForContext(
  context: RuntimeContext,
  event: HookEvent,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookBinding[] {
  return (context.config.hooks.on[event] ?? []).filter((binding) =>
    hookBindingMatchesContext(binding, context.workflowId, node?.id, gateId)
  );
}

function hookBindingMatchesContext(
  binding: HookBinding,
  workflowId: string,
  nodeId?: string,
  gateId?: string
): boolean {
  const where = binding.where;
  const filters: Array<readonly [string | undefined, string | undefined]> = [
    [where?.workflow, workflowId],
    [where?.node, nodeId],
    [where?.gate, gateId],
  ];
  return filters.every(bindingFilterMatches);
}

function bindingFilterMatches(
  filter: readonly [string | undefined, string | undefined]
): boolean {
  const [expected, actual] = filter;
  return expected === undefined || expected === actual;
}

export function commandHookPolicyFailure(
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  binding: HookBinding,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeFailure | undefined {
  if (commandHooksDisabled(context)) {
    return commandHookFailure(binding, "command hooks are disabled", node);
  }
  if (untrustedCommandHookDisabled(hookFunction, context)) {
    return commandHookFailure(binding, "command hook is not trusted", node);
  }
}

export function moduleHookPolicyFailure(
  binding: HookBinding,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeFailure | undefined {
  if (context.config.hooks.policy?.modules === "deny") {
    return runtimeHookFailure(
      binding,
      `hook '${binding.id}' failed`,
      ["module hooks are disabled"],
      node
    );
  }
}

export function commandHookFailure(
  binding: HookBinding,
  evidence: string,
  node?: PlannedWorkflowNode
): RuntimeFailure {
  return runtimeHookFailure(
    binding,
    `hook '${binding.id}' failed`,
    [evidence],
    node
  );
}

function commandHooksDisabled(context: RuntimeContext): boolean {
  return (
    context.hookPolicy.allowCommandHooks === false ||
    context.config.hooks.policy?.commands === "deny"
  );
}

function untrustedCommandHookDisabled(
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  context: RuntimeContext
): boolean {
  const commandPolicy = context.config.hooks.policy?.commands;
  return (
    hookFunction.trusted !== true &&
    (commandPolicy === "trusted-only" ||
      context.hookPolicy.allowUntrustedCommandHooks === false)
  );
}
