import { Context, Effect, Layer } from "effect";
import {
  type CommandExecutionContext,
  executeCommand,
} from "../command-executor";
import type { CommandExecutionOptions, NodeAttemptResult } from "../contracts";

export class CommandExecutor extends Context.Tag("CommandExecutor")<
  CommandExecutor,
  {
    readonly execute: (
      command: string[],
      context: CommandExecutionContext,
      options?: CommandExecutionOptions
    ) => Effect.Effect<NodeAttemptResult, unknown>;
  }
>() {}

export const CommandExecutorLive = Layer.succeed(CommandExecutor, {
  execute: (command, context, options) =>
    Effect.tryPromise(() => executeCommand(command, context, options)),
});
