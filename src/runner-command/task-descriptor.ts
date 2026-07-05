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

export const buildRunnerTaskDescriptor = (
  nodeId: string
): RunnerTaskDescriptor => runnerTaskDescriptorSchema.parse({ nodeId });

const parseRunnerTaskDescriptor = (raw: string): RunnerTaskDescriptor =>
  runnerTaskDescriptorSchema.parse(
    parseJson(raw, "runner task descriptor JSON")
  );

export const readRunnerTaskDescriptorEffect = (
  path = DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH
): Effect.Effect<RunnerTaskDescriptor, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    const raw = yield* io.readText(path);
    return yield* Effect.try({
      catch: (error) => error,
      try: () => parseRunnerTaskDescriptor(raw),
    });
  });
