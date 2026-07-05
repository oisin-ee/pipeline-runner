import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

export interface ScheduleArtifactInput {
  entrypointId: string;
  runId: string;
  task: string;
  worktreePath: string;
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
    delete process.env[key];
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
  const error = vi.spyOn(console, "error").mockImplementation((...messages) => {
    input.buffers.stderr.push(`${messages.map(String).join(" ")}\n`);
  });
  let thrown: unknown;

  try {
    process.env.PIPELINE_TARGET_PATH = input.workspaceRoot;
    const program = createCliProgram();
    program.configureOutput({
      writeErr: (value) => input.buffers.stderr.push(value),
      writeOut: (value) => input.buffers.stdout.push(value),
    });
    await program.parseAsync(
      ["node", "/repo/node_modules/.bin/moka", ...input.args],
      { from: "node" }
    );
  } catch (error) {
    thrown = error;
  } finally {
    log.mockRestore();
    error.mockRestore();
    restoreEnv("PIPELINE_TARGET_PATH", input.originalPipelineTargetPath);
  }

  return {
    stderr: input.buffers.stderr.join(""),
    stdout: input.buffers.stdout.join(""),
    thrown,
  };
};

export const writeMockScheduleArtifact = (
  input: ScheduleArtifactInput,
  options: {
    command: string;
    nodeId: string;
    rootWorkflowId: string;
  }
): string => {
  const schedulePath = `.pipeline/runs/${input.runId}/schedule.yaml`;
  const fullPath = join(input.worktreePath, schedulePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    [
      "version: 1",
      "kind: pipeline-schedule",
      `schedule_id: ${input.runId}`,
      `source_entrypoint: ${input.entrypointId}`,
      `task: ${input.task}`,
      "generated_at: 2026-06-17T00:00:00.000Z",
      `root_workflow: ${options.rootWorkflowId}`,
      "workflows:",
      `  ${options.rootWorkflowId}:`,
      "    nodes:",
      `      - id: ${options.nodeId}`,
      "        kind: command",
      `        command: [node, -e, "${options.command}"]`,
      "",
    ].join("\n")
  );
  return schedulePath;
};
