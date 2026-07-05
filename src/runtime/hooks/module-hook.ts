import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Option } from "effect";

import type { HookFunction } from "../../hooks";
import { isRecord } from "../../safe-json";
import type { HookFunctionSpec } from "../contracts";
import { hookContext } from "./context";
import { moduleHookPolicyFailure } from "./policy";
import { parseAndValidateHookResult, runtimeHookFailure } from "./results";
import type { HookExecutionInput, RuntimeHookInvocationResult } from "./types";

const moduleDefaultExportFailure = (
  input: HookExecutionInput
): RuntimeHookInvocationResult => ({
  failure: runtimeHookFailure(
    input.binding,
    `hook '${input.binding.id}' failed`,
    ["module hook must default-export a function"],
    input.node
  ),
});

const hookModuleSpecifier = (
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  context: HookExecutionInput["context"]
): string => {
  if (
    hookFunction.module.startsWith(".") ||
    hookFunction.module.startsWith("/")
  ) {
    return pathToFileURL(resolve(context.worktreePath, hookFunction.module))
      .href;
  }
  return hookFunction.module;
};

const isHookFunction = (value: unknown): value is HookFunction =>
  typeof value === "function";

const moduleDefaultHook = (value: unknown): Option.Option<HookFunction> => {
  if (!isRecord(value)) {
    return Option.none();
  }
  const candidate = value.default;
  return isHookFunction(candidate) ? Option.some(candidate) : Option.none();
};

const runWithTimeout = async <T>(
  run: () => Promise<T> | T,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> => {
  let timeout = Option.none<ReturnType<typeof setTimeout>>();
  try {
    return await Promise.race([
      Promise.resolve(run()),
      new Promise<never>((_, reject) => {
        const timeoutHandle = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
        timeoutHandle.unref();
        timeout = Option.some(timeoutHandle);
      }),
    ]);
  } finally {
    if (Option.isSome(timeout)) {
      clearTimeout(timeout.value);
    }
  }
};

const executeImportedModuleHook = async (
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> => {
  const imported: unknown = await import(
    hookModuleSpecifier(hookFunction, input.context)
  );
  const hook = moduleDefaultHook(imported);
  if (Option.isNone(hook)) {
    return moduleDefaultExportFailure(input);
  }
  const output = await runWithTimeout(
    async () =>
      await hook.value(
        hookContext(
          input.context,
          input.event,
          input.binding,
          input.failure,
          input.node,
          input.gateId
        )
      ),
    hookFunction.timeout_ms ?? input.context.hookPolicy.timeoutMs,
    `hook '${input.binding.id}' timed out`
  );
  return parseAndValidateHookResult(
    output,
    input.binding,
    hookFunction,
    input.context,
    input.node
  );
};

const runModuleHookFunction = async (
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> => {
  try {
    return await executeImportedModuleHook(hookFunction, input);
  } catch (error) {
    return {
      failure: runtimeHookFailure(
        input.binding,
        `hook '${input.binding.id}' failed`,
        [error instanceof Error ? error.message : String(error)],
        input.node
      ),
    };
  }
};

export const executeModuleHookFunction = (
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> | RuntimeHookInvocationResult => {
  const policyFailure = moduleHookPolicyFailure(
    input.binding,
    input.context,
    input.node
  );
  if (Option.isSome(policyFailure)) {
    return { failure: policyFailure.value };
  }
  return runModuleHookFunction(hookFunction, input);
};
