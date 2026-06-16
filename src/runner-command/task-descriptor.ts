import { Effect } from "effect";
import { z } from "zod";
import { RunnerCommandIoService } from "../runtime/services/runner-command-io-service";
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

export function readRunnerTaskDescriptorEffect(
  path = DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH
): Effect.Effect<RunnerTaskDescriptor, unknown, RunnerCommandIoService> {
  return Effect.gen(function* () {
    const io = yield* RunnerCommandIoService;
    const raw = yield* io.readText(path);
    return yield* Effect.try({
      try: () => parseRunnerTaskDescriptor(raw),
      catch: (error) => error,
    });
  });
}
