import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { vi } from "vitest";

export interface CliCapture {
  stderr: string;
  stdout: string;
  thrown?: unknown;
}

export interface CliOutputBuffers {
  stderr: string[];
  stdout: string[];
}

export const runPath = (
  workspaceRoot: string,
  runId: string,
  ...parts: string[]
): string => join(workspaceRoot, ".pipeline", "runs", runId, ...parts);

export const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf-8"));

export const readJsonl = (path: string): unknown[] => {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
};

export const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

export const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
};

export const runMokaCliInTarget = async (input: {
  args: string[];
  buffers: CliOutputBuffers;
  originalPipelineTargetPath: string | undefined;
  workspaceRoot: string;
}): Promise<CliCapture> => {
  const { createCliProgram } = await import("../src/cli/program");
  const log = vi.spyOn(console, "log").mockImplementation((...messages) => {
    input.buffers.stdout.push(`${messages.map(String).join(" ")}\n`);
  });
  const stderr = vi
    .spyOn(console, "error")
    .mockImplementation((...messages) => {
      input.buffers.stderr.push(`${messages.map(String).join(" ")}\n`);
    });
  let thrown: unknown;

  try {
    process.env.PIPELINE_TARGET_PATH = input.workspaceRoot;
    const program = createCliProgram();
    program.configureOutput({
      writeErr: (value) => {
        input.buffers.stderr.push(value);
      },
      writeOut: (value) => {
        input.buffers.stdout.push(value);
      },
    });
    await program.parseAsync(
      ["node", "/repo/node_modules/.bin/moka", ...input.args],
      { from: "node" }
    );
  } catch (error) {
    thrown = error;
  } finally {
    log.mockRestore();
    stderr.mockRestore();
    restoreEnv("PIPELINE_TARGET_PATH", input.originalPipelineTargetPath);
  }

  return {
    stderr: input.buffers.stderr.join(""),
    stdout: input.buffers.stdout.join(""),
    thrown,
  };
};
