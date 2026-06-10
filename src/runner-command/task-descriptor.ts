import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseJson } from "../safe-json";

export const DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH = "/etc/pipeline/task.json";

const runnerTaskDescriptorSchema = z
  .object({
    nodeId: z.string().min(1),
  })
  .strict();

export type RunnerTaskDescriptor = z.infer<typeof runnerTaskDescriptorSchema>;

export function buildRunnerTaskDescriptor(
  nodeId: string
): RunnerTaskDescriptor {
  return runnerTaskDescriptorSchema.parse({ nodeId });
}

function parseRunnerTaskDescriptor(raw: string): RunnerTaskDescriptor {
  return runnerTaskDescriptorSchema.parse(
    parseJson(raw, "runner task descriptor JSON")
  );
}

export function readRunnerTaskDescriptor(
  path = DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH
): RunnerTaskDescriptor {
  return parseRunnerTaskDescriptor(readFileSync(path, "utf8"));
}
