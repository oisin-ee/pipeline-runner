import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { HookContext } from "../../hooks";
import { parseJson as parseSafeJson } from "../../safe-json";
import type { CommandExecutionOptions, HookFunctionSpec } from "../contracts";
import {
  CommandExecutor,
  CommandExecutorLive,
} from "../services/command-executor-service";
import { hookContext } from "./context";
import { commandHookFailure, commandHookPolicyFailure } from "./policy";
import { parseAndValidateHookResult, runtimeHookFailure } from "./results";
import type { HookExecutionInput, RuntimeHookInvocationResult } from "./types";

interface CommandHookTempFiles {
  inputPath: string;
  resultPath: string;
  tempDir: string;
}

export function executeCommandHookFunction(
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  input: HookExecutionInput
): Promise<RuntimeHookInvocationResult> {
  const program = executeCommandHookFunctionEffect(hookFunction, input);
  return Effect.runPromise(Effect.provide(program, CommandExecutorLive));
}

function hookEnv(
  hook: Extract<HookFunctionSpec, { kind: "command" }>,
  context: Pick<HookExecutionInput["context"], "hookPolicy">
): Record<string, string> {
  return {
    ...Object.fromEntries(commandHookEnvEntries(hook, context)),
    ...context.hookPolicy.env,
    ...(hook.env?.set ?? {}),
  };
}

function commandHookEnvEntries(
  hook: Extract<HookFunctionSpec, { kind: "command" }>,
  context: Pick<HookExecutionInput["context"], "hookPolicy">
): [string, string][] {
  const passthrough = new Set([
    ...context.hookPolicy.envPassthrough,
    ...(hook.env?.passthrough ?? []),
  ]);
  return [...passthrough].flatMap(commandHookEnvEntry);
}

function commandHookEnvEntry(name: string): [string, string][] {
  const value = process.env[name];
  return value === undefined ? [] : [[name, value]];
}

function executeCommandHookFunctionEffect(
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  input: HookExecutionInput
): Effect.Effect<RuntimeHookInvocationResult, unknown, CommandExecutor> {
  return Effect.gen(function* () {
    const policyFailure = commandHookPolicyFailure(
      hookFunction,
      input.binding,
      input.context,
      input.node
    );
    if (policyFailure) {
      return { failure: policyFailure };
    }
    const files = yield* createHookTempFiles();
    return yield* runCommandHookWithTempFiles(files, hookFunction, input).pipe(
      Effect.ensuring(removeHookTempDir(files.tempDir))
    );
  });
}

function createHookTempFiles(): Effect.Effect<CommandHookTempFiles, unknown> {
  return Effect.try(() => {
    const tempDir = mkdtempSync(join(tmpdir(), "pipeline-hook-"));
    return {
      inputPath: join(tempDir, "input.json"),
      resultPath: join(tempDir, "result.json"),
      tempDir,
    };
  });
}

function removeHookTempDir(tempDir: string): Effect.Effect<void> {
  return Effect.sync(() => rmSync(tempDir, { force: true, recursive: true }));
}

function runCommandHookWithTempFiles(
  files: CommandHookTempFiles,
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  input: HookExecutionInput
): Effect.Effect<RuntimeHookInvocationResult, unknown, CommandExecutor> {
  return Effect.gen(function* () {
    const { binding, context, event, failure, gateId, node } = input;
    yield* writeCommandHookInput(
      files.inputPath,
      hookContext(context, event, binding, failure, node, gateId)
    );
    const executor = yield* CommandExecutor;
    const commandResult = yield* executor.execute(
      hookFunction.command,
      context,
      commandHookOptions(hookFunction, context, files)
    );
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
    return yield* readCommandHookResult(
      files.resultPath,
      binding,
      hookFunction,
      context,
      node
    );
  });
}

function writeCommandHookInput(
  inputPath: string,
  context: HookContext
): Effect.Effect<void, unknown> {
  return Effect.try(() => writeFileSync(inputPath, JSON.stringify(context)));
}

function commandHookOptions(
  hookFunction: Extract<HookFunctionSpec, { kind: "command" }>,
  context: HookExecutionInput["context"],
  files: CommandHookTempFiles
): CommandExecutionOptions {
  return {
    env: {
      ...hookEnv(hookFunction, context),
      PIPELINE_HOOK_INPUT: files.inputPath,
      PIPELINE_HOOK_RESULT: files.resultPath,
    },
    extendEnv: false,
    outputLimitBytes:
      hookFunction.output_limit_bytes ?? context.hookPolicy.outputLimitBytes,
    timeout: hookFunction.timeout_ms ?? context.hookPolicy.timeoutMs,
  };
}

function readCommandHookResult(
  resultPath: string,
  binding: HookExecutionInput["binding"],
  hookFunction: HookFunctionSpec,
  context: HookExecutionInput["context"],
  node?: HookExecutionInput["node"]
): Effect.Effect<RuntimeHookInvocationResult, unknown> {
  return Effect.gen(function* () {
    const resultExists = yield* Effect.sync(() => existsSync(resultPath));
    if (!resultExists) {
      return {
        failure: commandHookFailure(
          binding,
          "command hook did not write PIPELINE_HOOK_RESULT",
          node
        ),
      };
    }
    return yield* parseCommandHookResult(
      resultPath,
      binding,
      hookFunction,
      context,
      node
    );
  });
}

function parseCommandHookResult(
  resultPath: string,
  binding: HookExecutionInput["binding"],
  hookFunction: HookFunctionSpec,
  context: HookExecutionInput["context"],
  node?: HookExecutionInput["node"]
): Effect.Effect<RuntimeHookInvocationResult, unknown> {
  return Effect.try(() =>
    parseAndValidateHookResult(
      parseSafeJson(readFileSync(resultPath, "utf8"), "hook result"),
      binding,
      hookFunction,
      context,
      node
    )
  );
}
