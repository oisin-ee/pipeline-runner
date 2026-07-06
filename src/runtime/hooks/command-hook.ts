import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Option } from "effect";

import type { HookContext } from "../../hooks";
import { parseJson as parseSafeJson } from "../../safe-json";
import type { CommandExecutionOptions, HookFunctionSpec } from "../contracts";
import { CommandExecutor, CommandExecutorLive } from "../services/command-executor-service";
import { hookContext } from "./context";
import { commandHookFailure, commandHookPolicyFailure } from "./policy";
import { parseAndValidateHookResult, runtimeHookFailure } from "./results";
import type { HookExecutionInput, RuntimeHookInvocationResult } from "./types";

interface CommandHookTempFiles {
  inputPath: string;
  resultPath: string;
  tempDir: string;
}

const commandHookEnvEntry = (name: string): [string, string][] => {
  const value = process.env[name];
  return value === undefined ? [] : [[name, value]];
};

const commandHookEnvEntries = (
  hook: Extract<HookFunctionSpec, { kind: "command" }>,
  context: Pick<HookExecutionInput["context"], "hookPolicy">,
): [string, string][] => {
  const passthrough = new Set([...context.hookPolicy.envPassthrough, ...(hook.env?.passthrough ?? [])]);
  return [...passthrough].flatMap(commandHookEnvEntry);
};

const hookEnv = (
  hook: Extract<HookFunctionSpec, { kind: "command" }>,
  context: Pick<HookExecutionInput["context"], "hookPolicy">,
): Record<string, string> => ({
  ...Object.fromEntries(commandHookEnvEntries(hook, context)),
  ...context.hookPolicy.env,
  ...hook.env?.set,
});

const createHookTempFiles = (): Effect.Effect<CommandHookTempFiles, unknown> =>
  Effect.try(() => {
    const tempDir = mkdtempSync(join(tmpdir(), "pipeline-hook-"));
    return {
      inputPath: join(tempDir, "input.json"),
      resultPath: join(tempDir, "result.json"),
      tempDir,
    };
  });

const removeHookTempDir = (tempDir: string): Effect.Effect<void> =>
  Effect.sync(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

const writeCommandHookInput = (inputPath: string, context: HookContext): Effect.Effect<void, unknown> =>
  Effect.try(() => {
    writeFileSync(inputPath, JSON.stringify(context));
  });

const commandHookOptions = (
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  context: HookExecutionInput["context"],
  files: CommandHookTempFiles,
): CommandExecutionOptions => ({
  env: {
    ...hookEnv(hookFunction, context),
    PIPELINE_HOOK_INPUT: files.inputPath,
    PIPELINE_HOOK_RESULT: files.resultPath,
  },
  extendEnv: false,
  outputLimitBytes: hookFunction.output_limit_bytes ?? context.hookPolicy.outputLimitBytes,
  timeout: hookFunction.timeout_ms ?? context.hookPolicy.timeoutMs,
});

const parseCommandHookResult = (
  resultPath: string,
  binding: HookExecutionInput["binding"],
  hookFunction: HookFunctionSpec,
  context: HookExecutionInput["context"],
  node?: HookExecutionInput["node"],
): Effect.Effect<RuntimeHookInvocationResult, unknown> =>
  Effect.try(() =>
    parseAndValidateHookResult(
      parseSafeJson(readFileSync(resultPath, "utf-8"), "hook result"),
      binding,
      hookFunction,
      context,
      node,
    ),
  );

const readCommandHookResult = (
  resultPath: string,
  binding: HookExecutionInput["binding"],
  hookFunction: HookFunctionSpec,
  context: HookExecutionInput["context"],
  node?: HookExecutionInput["node"],
): Effect.Effect<RuntimeHookInvocationResult, unknown> =>
  Effect.gen(function* effectBody() {
    const resultExists = yield* Effect.sync(() => existsSync(resultPath));
    if (!resultExists) {
      return {
        failure: commandHookFailure(binding, "command hook did not write PIPELINE_HOOK_RESULT", node),
      };
    }
    return yield* parseCommandHookResult(resultPath, binding, hookFunction, context, node);
  });

const runCommandHookWithTempFiles = (
  files: CommandHookTempFiles,
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  input: HookExecutionInput,
): Effect.Effect<RuntimeHookInvocationResult, unknown, CommandExecutor> =>
  Effect.gen(function* effectBody() {
    const { binding, context, event, failure, gateId, node } = input;
    yield* writeCommandHookInput(files.inputPath, hookContext(context, event, binding, failure, node, gateId));
    const executor = yield* CommandExecutor;
    const commandResult = yield* executor.execute(
      hookFunction.command,
      context,
      commandHookOptions(hookFunction, context, files),
    );
    if (commandResult.exitCode !== 0) {
      return {
        failure: runtimeHookFailure(binding, `hook '${binding.id}' failed`, commandResult.evidence, node),
      };
    }
    return yield* readCommandHookResult(files.resultPath, binding, hookFunction, context, node);
  });

const executeCommandHookFunctionEffect = (
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  input: HookExecutionInput,
): Effect.Effect<RuntimeHookInvocationResult, unknown, CommandExecutor> =>
  Effect.gen(function* effectBody() {
    const policyFailure = commandHookPolicyFailure(hookFunction, input.binding, input.context, input.node);
    if (Option.isSome(policyFailure)) {
      return { failure: policyFailure.value };
    }
    const files = yield* createHookTempFiles();
    return yield* runCommandHookWithTempFiles(files, hookFunction, input).pipe(
      Effect.ensuring(removeHookTempDir(files.tempDir)),
    );
  });

export const executeCommandHookFunction = async (
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  input: HookExecutionInput,
): Promise<RuntimeHookInvocationResult> => {
  const program = executeCommandHookFunctionEffect(hookFunction, input);
  return await Effect.runPromise(Effect.provide(program, CommandExecutorLive));
};
