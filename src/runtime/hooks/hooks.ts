import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createActor, waitFor } from "xstate";
import type { HookEvent } from "../../config";
import {
  type HookContext,
  type HookFunction,
  type HookResult,
  parseHookResult,
} from "../../hooks";
import { runtimeActorId } from "../../runtime-machines/contracts";
import { hookInvocationMachine } from "../../runtime-machines/hook-machine";
import { parseJson as parseSafeJson } from "../../safe-json";
import type { PlannedWorkflowNode } from "../../workflow-planner";
import { executeCommand } from "../command-executor";
import type {
  HookBinding,
  HookFunctionSpec,
  PipelineTaskContext,
  RuntimeContext,
  RuntimeFailure,
} from "../contracts";
import { emit, runtimeInspection, runtimeSystemId } from "../events";
import { validateJsonSchemaSource } from "../json-validation";

export async function dispatchHooks(
  context: RuntimeContext,
  event: HookEvent,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeFailure | null> {
  for (const binding of hookBindingsForContext(context, event, node, gateId)) {
    if (isCancelled(context)) {
      return null;
    }
    const hookFunction = context.config.hooks.functions[binding.function];
    emitHookStart(context, event, binding, node, gateId);
    const result = await runHookInvocationActor(
      context,
      binding,
      hookFunction,
      event,
      failure,
      node,
      gateId
    );
    emitHookFinish(context, event, binding, result.failure, node, gateId);
    if (result.hookResult) {
      recordHookResult(
        context,
        event,
        binding,
        result.hookResult,
        node,
        gateId
      );
    }
    if (result.failure && binding.failure === "fail") {
      context.hookFailures.push(result.failure);
      return result.failure;
    }
    if (result.failure) {
      context.hookFailures.push(result.failure);
    }
  }
  return null;
}

interface RuntimeHookInvocationResult {
  failure?: RuntimeFailure;
  hookResult?: HookResult;
}

function hookBindingsForContext(
  context: RuntimeContext,
  event: HookEvent,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookBinding[] {
  return (context.config.hooks.on[event] ?? []).filter((binding) =>
    hookBindingMatchesContext(binding, context.workflowId, node?.id, gateId)
  );
}

export function hookBindingMatchesContext(
  binding: HookBinding,
  workflowId: string,
  nodeId?: string,
  gateId?: string
): boolean {
  const where = binding.where;
  return (
    (!where?.workflow || where.workflow === workflowId) &&
    (!where?.node || where.node === nodeId) &&
    (!where?.gate || where.gate === gateId)
  );
}

function recordHookResult(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  if (binding.result?.save_as) {
    context.hookResults.set(binding.result.save_as, result);
  }
  if (binding.result?.publish === true) {
    emit(context, {
      event,
      functionId: binding.function,
      hookId: binding.id,
      status: result.status,
      type: "hook.result",
      workflowId: context.workflowId,
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      ...(gateId ? { gateId } : {}),
      ...(node ? { nodeId: node.id } : {}),
      ...(result.outputs ? { outputs: result.outputs } : {}),
      ...(result.summary ? { summary: result.summary } : {}),
    });
  }
}

function runtimeHookFailure(
  binding: HookBinding,
  reason: string,
  evidence: string[],
  node?: PlannedWorkflowNode
): RuntimeFailure {
  return {
    evidence,
    gate: binding.id,
    nodeId: node?.id,
    reason,
  };
}

function hookResultFailure(
  binding: HookBinding,
  result: HookResult,
  node?: PlannedWorkflowNode
): RuntimeFailure | undefined {
  if (result.status !== "fail") {
    return;
  }
  return runtimeHookFailure(
    binding,
    result.summary ?? `hook '${binding.id}' failed`,
    [result.summary ?? `hook '${binding.id}' returned fail`],
    node
  );
}

function validatedHookResult(
  result: HookResult,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeHookInvocationResult {
  const schema = hookFunction.returns?.schema;
  if (!schema) {
    return {
      failure: hookResultFailure(binding, result, node),
      hookResult: result,
    };
  }
  const validation = validateJsonSchemaSource(
    JSON.stringify(result),
    schema,
    context.worktreePath
  );
  if (!validation.passed) {
    return {
      failure: runtimeHookFailure(
        binding,
        validation.reason ?? "hook result schema validation failed",
        validation.evidence,
        node
      ),
      hookResult: result,
    };
  }
  return {
    failure: hookResultFailure(binding, result, node),
    hookResult: result,
  };
}

function parseAndValidateHookResult(
  value: unknown,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  context: RuntimeContext,
  node?: PlannedWorkflowNode
): RuntimeHookInvocationResult {
  try {
    return validatedHookResult(
      parseHookResult(value),
      binding,
      hookFunction,
      context,
      node
    );
  } catch (err) {
    return {
      failure: runtimeHookFailure(
        binding,
        "hook result validation failed",
        [err instanceof Error ? err.message : String(err)],
        node
      ),
    };
  }
}

async function runHookInvocationActor(
  context: RuntimeContext,
  binding: HookBinding,
  hookFunction: HookFunctionSpec,
  event: HookEvent,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeHookInvocationResult> {
  let invocationResult: RuntimeHookInvocationResult = {};
  const actor = createActor(hookInvocationMachine, {
    id: runtimeActorId("hook", {
      hookId: binding.id,
      nodeId: node?.id,
      runId: context.runId,
      workflowId: context.workflowId,
    }),
    input: {
      actor: {
        id: runtimeActorId("hook", {
          hookId: binding.id,
          nodeId: node?.id,
          runId: context.runId,
          workflowId: context.workflowId,
        }),
        kind: "hook",
        systemId: runtimeSystemId(context),
      },
      emit: context.observability,
      execute: async () => {
        invocationResult = await executeHookFunction(
          hookFunction,
          binding,
          event,
          context,
          failure,
          node,
          gateId
        );
        return invocationResult.failure
          ? {
              failure: invocationResult.failure,
              reason: invocationResult.failure.reason,
              status: "failed" as const,
            }
          : { status: "passed" as const };
      },
      hookId: binding.id,
      nodeId: node?.id,
      required: binding.failure === "fail",
    },
    ...(runtimeInspection(context)
      ? { inspect: runtimeInspection(context) }
      : {}),
  });
  actor.start();
  actor.send({ type: "START" });
  const snapshot = await waitFor(actor, (state) => state.status === "done");
  actor.stop();
  return snapshot.context.result?.failure
    ? { ...invocationResult, failure: snapshot.context.result.failure }
    : invocationResult;
}

function executeHookFunction(
  hookFunction: HookFunctionSpec,
  binding: HookBinding,
  event: HookEvent,
  context: RuntimeContext,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeHookInvocationResult> | RuntimeHookInvocationResult {
  switch (hookFunction.kind) {
    case "module":
      return executeModuleHookFunction(
        hookFunction,
        binding,
        event,
        context,
        failure,
        node,
        gateId
      );
    case "command":
      return executeCommandHookFunction(
        hookFunction,
        binding,
        event,
        context,
        failure,
        node,
        gateId
      );
    default: {
      const _exhaustive: never = hookFunction;
      return {
        failure: runtimeHookFailure(
          binding,
          "unsupported hook function",
          [`unsupported hook function: ${String(_exhaustive)}`],
          node
        ),
      };
    }
  }
}

async function executeModuleHookFunction(
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  binding: HookBinding,
  event: HookEvent,
  context: RuntimeContext,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeHookInvocationResult> {
  if (context.config.hooks.policy?.modules === "deny") {
    return {
      failure: runtimeHookFailure(
        binding,
        `hook '${binding.id}' failed`,
        ["module hooks are disabled"],
        node
      ),
    };
  }
  try {
    const imported = await import(hookModuleSpecifier(hookFunction, context));
    if (typeof imported.default !== "function") {
      return {
        failure: runtimeHookFailure(
          binding,
          `hook '${binding.id}' failed`,
          ["module hook must default-export a function"],
          node
        ),
      };
    }
    const output = await runWithTimeout(
      () =>
        (imported.default as HookFunction)(
          hookContext(context, event, binding, failure, node, gateId)
        ),
      hookFunction.timeout_ms ?? context.hookPolicy.timeoutMs,
      `hook '${binding.id}' timed out`
    );
    return parseAndValidateHookResult(
      output,
      binding,
      hookFunction,
      context,
      node
    );
  } catch (err) {
    return {
      failure: runtimeHookFailure(
        binding,
        `hook '${binding.id}' failed`,
        [err instanceof Error ? err.message : String(err)],
        node
      ),
    };
  }
}

function hookModuleSpecifier(
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  context: RuntimeContext
): string {
  if (
    hookFunction.module.startsWith(".") ||
    hookFunction.module.startsWith("/")
  ) {
    return pathToFileURL(resolve(context.worktreePath, hookFunction.module))
      .href;
  }
  return hookFunction.module;
}

async function executeCommandHookFunction(
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  binding: HookBinding,
  event: HookEvent,
  context: RuntimeContext,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): Promise<RuntimeHookInvocationResult> {
  if (context.hookPolicy.allowCommandHooks === false) {
    return {
      failure: runtimeHookFailure(
        binding,
        `hook '${binding.id}' failed`,
        ["command hooks are disabled"],
        node
      ),
    };
  }
  if (
    hookFunction.trusted !== true &&
    (context.config.hooks.policy?.commands === "trusted-only" ||
      context.hookPolicy.allowUntrustedCommandHooks === false)
  ) {
    return {
      failure: runtimeHookFailure(
        binding,
        `hook '${binding.id}' failed`,
        ["command hook is not trusted"],
        node
      ),
    };
  }
  if (context.config.hooks.policy?.commands === "deny") {
    return {
      failure: runtimeHookFailure(
        binding,
        `hook '${binding.id}' failed`,
        ["command hooks are disabled"],
        node
      ),
    };
  }
  const tempDir = mkdtempSync(join(tmpdir(), "pipeline-hook-"));
  const inputPath = join(tempDir, "input.json");
  const resultPath = join(tempDir, "result.json");
  try {
    writeFileSync(
      inputPath,
      JSON.stringify(
        hookContext(context, event, binding, failure, node, gateId)
      )
    );
    const commandResult = await executeCommand(hookFunction.command, context, {
      env: {
        ...hookEnv(hookFunction, context),
        PIPELINE_HOOK_INPUT: inputPath,
        PIPELINE_HOOK_RESULT: resultPath,
      },
      extendEnv: false,
      outputLimitBytes:
        hookFunction.output_limit_bytes ?? context.hookPolicy.outputLimitBytes,
      timeout: hookFunction.timeout_ms ?? context.hookPolicy.timeoutMs,
    });
    if (commandResult.exitCode !== 0) {
      return {
        failure: runtimeHookFailure(
          binding,
          `hook '${binding.id}' failed`,
          commandResult.evidence,
          node
        ),
      };
    }
    if (!existsSync(resultPath)) {
      return {
        failure: runtimeHookFailure(
          binding,
          `hook '${binding.id}' failed`,
          ["command hook did not write PIPELINE_HOOK_RESULT"],
          node
        ),
      };
    }
    return parseAndValidateHookResult(
      parseSafeJson(readFileSync(resultPath, "utf8"), "hook result"),
      binding,
      hookFunction,
      context,
      node
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function hookContext(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  failure?: RuntimeFailure,
  node?: PlannedWorkflowNode,
  gateId?: string
): HookContext {
  const taskContext = node
    ? effectiveTaskContext(node, context)
    : context.taskContext;
  return {
    event: {
      hookId: binding.id,
      type: event,
      workflowId: context.workflowId,
      ...(gateId ? { gateId } : {}),
      ...(node ? { nodeId: node.id } : {}),
    },
    input: binding.with ?? {},
    results: Object.fromEntries(context.hookResults),
    task: context.task,
    workflow: { id: context.workflowId },
    ...(failure ? { failure } : {}),
    ...(node ? { node: { id: node.id } } : {}),
    ...(taskContext ? { taskContext } : {}),
  };
}

function effectiveTaskContext(
  node: PlannedWorkflowNode,
  context: RuntimeContext
): PipelineTaskContext | undefined {
  return node.taskContext ?? context.taskContext;
}

async function runWithTimeout<T>(
  run: () => Promise<T> | T,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(run()),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeoutMs
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function emitHookStart(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  emit(context, {
    event,
    functionId: binding.function,
    hookId: binding.id,
    required: binding.failure === "fail",
    type: "hook.start",
    workflowId: context.workflowId,
    ...(node ? { nodeId: node.id } : {}),
    ...(gateId ? { gateId } : {}),
  });
}

function emitHookFinish(
  context: RuntimeContext,
  event: HookEvent,
  binding: HookBinding,
  result: RuntimeFailure | undefined,
  node?: PlannedWorkflowNode,
  gateId?: string
): void {
  emit(context, {
    event,
    functionId: binding.function,
    hookId: binding.id,
    passed: result === undefined,
    required: binding.failure === "fail",
    type: "hook.finish",
    workflowId: context.workflowId,
    ...(node ? { nodeId: node.id } : {}),
    ...(gateId ? { gateId } : {}),
    ...(result?.reason ? { reason: result.reason } : {}),
  });
}

export function hookEnv(
  hook: Extract<HookFunctionSpec, { kind: "command" }>,
  context: Pick<RuntimeContext, "hookPolicy">
): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = new Set([
    ...context.hookPolicy.envPassthrough,
    ...(hook.env?.passthrough ?? []),
  ]);
  for (const name of passthrough) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return {
    ...env,
    ...context.hookPolicy.env,
    ...(hook.env?.set ?? {}),
  };
}

function isCancelled(context: RuntimeContext): boolean {
  return context.signal?.aborted === true;
}
