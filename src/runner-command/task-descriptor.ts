import * as Effect from "effect/Effect";

import { RunnerCommandIoService } from "../runtime/services/runner-command-io-service";
import { parseJson } from "../safe-json";
import { parseStrictWithSchema, requiredString, struct } from "../schema-boundary";

export const DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH = "/etc/pipeline/task.json";

const runnerTaskDescriptorSchema = struct({
  nodeId: requiredString,
});

export type RunnerTaskDescriptor = typeof runnerTaskDescriptorSchema.Type;

export const buildRunnerTaskDescriptor = (nodeId: string): RunnerTaskDescriptor =>
  parseStrictWithSchema(runnerTaskDescriptorSchema, { nodeId });

const parseRunnerTaskDescriptor = (raw: string): RunnerTaskDescriptor =>
  parseStrictWithSchema(runnerTaskDescriptorSchema, parseJson(raw, "runner task descriptor JSON"));

export const readRunnerTaskDescriptorEffect = (
  path = DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH,
): Effect.Effect<RunnerTaskDescriptor, unknown, RunnerCommandIoService> =>
  Effect.gen(function* effectBody() {
    const io = yield* RunnerCommandIoService;
    const raw = yield* io.readText(path);
    return yield* Effect.try({
      catch: (error) => error,
      try: () => parseRunnerTaskDescriptor(raw),
    });
  });
