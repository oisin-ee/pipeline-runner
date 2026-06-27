import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookFunction } from "../../hooks";
import { isRecord } from "../../safe-json";
import type { HookFunctionSpec } from "../contracts";
import { hookContext } from "./context";
import { moduleHookPolicyFailure } from "./policy";
import { parseAndValidateHookResult, runtimeHookFailure } from "./results";
import type { HookExecutionInput, RuntimeHookInvocationResult } from "./types";

export function executeModuleHookFunction(
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> | RuntimeHookInvocationResult {
  const policyFailure = moduleHookPolicyFailure(
    input.binding,
    input.context,
    input.node
  );
  if (policyFailure) {
    return { failure: policyFailure };
  }
  return runModuleHookFunction(hookFunction, input);
}

async function runModuleHookFunction(
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> {
  try {
    return await executeImportedModuleHook(hookFunction, input);
  } catch (err) {
    return {
      failure: runtimeHookFailure(
        input.binding,
        `hook '${input.binding.id}' failed`,
        [err instanceof Error ? err.message : String(err)],
        input.node
      ),
    };
  }
}

async function executeImportedModuleHook(
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> {
  const imported: unknown = await import(
    hookModuleSpecifier(hookFunction, input.context)
  );
  const hook = moduleDefaultHook(imported);
  if (!hook) {
    return moduleDefaultExportFailure(input);
  }
  const output = await runWithTimeout(
    () =>
      hook(
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
}

function moduleDefaultExportFailure(
  input: HookExecutionInput
): RuntimeHookInvocationResult {
  return {
    failure: runtimeHookFailure(
      input.binding,
      `hook '${input.binding.id}' failed`,
      ["module hook must default-export a function"],
      input.node
    ),
  };
}

function hookModuleSpecifier(
  hookFunction: Extract<HookFunctionSpec, { kind: "module" }>,
  context: HookExecutionInput["context"]
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

function moduleDefaultHook(value: unknown): HookFunction | undefined {
  if (!isRecord(value)) {
    return;
  }
  const candidate = value.default;
  return isHookFunction(candidate) ? candidate : undefined;
}

function isHookFunction(value: unknown): value is HookFunction {
  return typeof value === "function";
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
