import type { HookFunctionSpec } from "../contracts";
import { executeCommandHookFunction } from "./command-hook";
import { executeModuleHookFunction } from "./module-hook";
import type {
  HookExecutionInput,
  HookFunctionExecutor,
  HookFunctionKind,
} from "./types";

interface HookKindModule<K extends HookFunctionKind> {
  execute: (
    hookFunction: Extract<HookFunctionSpec, { kind: K }>,
    input: HookExecutionInput
  ) => ReturnType<HookFunctionExecutor>;
  kind: K;
}

const commandHookModule = {
  execute: executeCommandHookFunction,
  kind: "command",
} satisfies HookKindModule<"command">;

const moduleHookModule = {
  execute: executeModuleHookFunction,
  kind: "module",
} satisfies HookKindModule<"module">;

const hasHookKind = <K extends HookFunctionKind>(
  hookFunction: HookFunctionSpec,
  kind: K
): hookFunction is Extract<HookFunctionSpec, { kind: K }> =>
  hookFunction.kind === kind;

const forHookKind =
  <K extends HookFunctionKind>(
    kind: K,
    execute: (
      hookFunction: Extract<HookFunctionSpec, { kind: K }>,
      input: HookExecutionInput
    ) => ReturnType<HookFunctionExecutor>
  ): HookFunctionExecutor =>
  async (input) => {
    if (!hasHookKind(input.hookFunction, kind)) {
      throw new Error(
        `hook registry mismatch: handler '${kind}' received '${input.hookFunction.kind}'`
      );
    }
    return await execute(input.hookFunction, input);
  };

const hookExecutors: Record<HookFunctionKind, HookFunctionExecutor> = {
  command: forHookKind(commandHookModule.kind, commandHookModule.execute),
  module: forHookKind(moduleHookModule.kind, moduleHookModule.execute),
};

export const executeHookFunction = (
  input: HookExecutionInput
): ReturnType<HookFunctionExecutor> =>
  hookExecutors[input.hookFunction.kind](input);
