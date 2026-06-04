import { execa } from "execa";
import type { CommandExecutionOptions, NodeAttemptResult } from "../contracts";

export interface CommandExecutionContext {
  signal?: AbortSignal;
  worktreePath: string;
}

export async function executeCommand(
  command: string[],
  context: CommandExecutionContext,
  options: CommandExecutionOptions = {}
): Promise<NodeAttemptResult> {
  if (command.length === 0) {
    return { evidence: ["empty command"], exitCode: 1, output: "" };
  }
  try {
    const result = await execa(command[0] as string, command.slice(1), {
      cancelSignal: context.signal,
      cwd: context.worktreePath,
      ...(options.env ? { env: options.env } : {}),
      ...(options.extendEnv === false ? { extendEnv: false } : {}),
      ...(options.input ? { input: options.input } : {}),
      ...(options.outputLimitBytes
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
  } catch (err) {
    const e = err as {
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      timedOut?: boolean;
    };
    const output = limitOutput(
      [e.stdout, e.stderr].filter(Boolean).join("\n"),
      options.outputLimitBytes
    );
    return {
      evidence: [
        `command exited ${e.exitCode ?? 1}: ${command.join(" ")}`,
        ...(e.timedOut ? ["command timed out"] : []),
        ...output.evidence,
        output.text,
      ].filter(Boolean),
      exitCode: e.exitCode ?? 1,
      output: output.text,
      timedOut: Boolean(e.timedOut),
    };
  }
}

function limitOutput(
  text: string,
  limitBytes?: number
): { evidence: string[]; text: string } {
  if (!limitBytes || Buffer.byteLength(text, "utf8") <= limitBytes) {
    return { evidence: [], text };
  }
  const truncated = Buffer.from(text, "utf8")
    .subarray(0, limitBytes)
    .toString("utf8");
  return {
    evidence: [
      `command output truncated to ${limitBytes} bytes from ${Buffer.byteLength(
        text,
        "utf8"
      )} bytes`,
    ],
    text: truncated,
  };
}
