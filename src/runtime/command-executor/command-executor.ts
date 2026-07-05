import { getOrElse, none, some, type Option } from "effect/Option";
import { execa } from "execa";

import type { CommandExecutionOptions, NodeAttemptResult } from "../contracts";

export interface CommandExecutionContext {
  signal?: AbortSignal;
  worktreePath: string;
}

interface CommandErrorFields {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (value: unknown, field: string): Option<string> => {
  if (!isUnknownRecord(value)) {
    return none();
  }
  const fieldValue = value[field];
  return typeof fieldValue === "string" ? some(fieldValue) : none();
};

const numberField = (value: unknown, field: string): Option<number> => {
  if (!isUnknownRecord(value)) {
    return none();
  }
  const fieldValue = value[field];
  return typeof fieldValue === "number" ? some(fieldValue) : none();
};

const booleanField = (value: unknown, field: string): Option<boolean> => {
  if (!isUnknownRecord(value)) {
    return none();
  }
  const fieldValue = value[field];
  return typeof fieldValue === "boolean" ? some(fieldValue) : none();
};

const commandErrorFields = (error: unknown): CommandErrorFields => ({
  exitCode: getOrElse(numberField(error, "exitCode"), () => 1),
  stderr: getOrElse(stringField(error, "stderr"), () => ""),
  stdout: getOrElse(stringField(error, "stdout"), () => ""),
  timedOut: getOrElse(booleanField(error, "timedOut"), () => false) === true,
});

const limitOutput = (
  text: string,
  limitBytes?: number
): { evidence: string[]; text: string } => {
  if (
    limitBytes === undefined ||
    Buffer.byteLength(text, "utf-8") <= limitBytes
  ) {
    return { evidence: [], text };
  }
  const truncated = Buffer.from(text, "utf-8")
    .subarray(0, limitBytes)
    .toString("utf-8");
  return {
    evidence: [
      `command output truncated to ${limitBytes} bytes from ${Buffer.byteLength(
        text,
        "utf-8"
      )} bytes`,
    ],
    text: truncated,
  };
};

export const executeCommand = async (
  command: string[],
  context: CommandExecutionContext,
  options: CommandExecutionOptions = {}
): Promise<NodeAttemptResult> => {
  if (command.length === 0) {
    return { evidence: ["empty command"], exitCode: 1, output: "" };
  }
  try {
    const result = await execa(command[0], command.slice(1), {
      cancelSignal: context.signal,
      cwd: context.worktreePath,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.extendEnv === false ? { extendEnv: false } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.outputLimitBytes !== undefined
        ? { maxBuffer: options.outputLimitBytes }
        : {}),
      timeout: options.timeout,
    });
    const output = limitOutput(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
      options.outputLimitBytes
    );
    return {
      evidence: [
        `command exited ${result.exitCode ?? 0}: ${command.join(" ")}`,
        ...output.evidence,
      ],
      exitCode: result.exitCode ?? 0,
      output: output.text,
    };
  } catch (error) {
    const commandError = commandErrorFields(error);
    const output = limitOutput(
      [commandError.stdout, commandError.stderr].filter(Boolean).join("\n"),
      options.outputLimitBytes
    );
    return {
      evidence: [
        `command exited ${commandError.exitCode}: ${command.join(" ")}`,
        ...(commandError.timedOut ? ["command timed out"] : []),
        ...output.evidence,
        output.text,
      ].filter(Boolean),
      exitCode: commandError.exitCode,
      output: output.text,
      timedOut: commandError.timedOut,
    };
  }
};
