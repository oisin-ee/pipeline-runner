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

const TRAILING_SLASHES_RE = /\/+$/u;

const trimTrailingSlashes = (path: string): string =>
  path === "/" ? "" : path.replace(TRAILING_SLASHES_RE, "");

const hookModuleSpecifier = (
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  context: HookExecutionInput["context"]
): string => {
  if (hookFunction.module.startsWith("/")) {
    return hookFunction.module;
  }
  if (hookFunction.module.startsWith(".")) {
    return `${trimTrailingSlashes(context.worktreePath)}/${hookFunction.module}`;
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

const timeoutFailure = async (
  timeoutMs: number,
  timeoutMessage: string,
  signal: AbortSignal
): Promise<never> => {
  const timers = await import("node:timers/promises");
  await timers.setTimeout(timeoutMs, undefined, { ref: false, signal });
  throw new Error(timeoutMessage);
};

const runWithTimeout = async <T>(
  run: () => Promise<T> | T,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> => {
  const abortController = new AbortController();
  try {
    return await Promise.race([
      run(),
      timeoutFailure(timeoutMs, timeoutMessage, abortController.signal),
    ]);
  } finally {
    abortController.abort();
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
