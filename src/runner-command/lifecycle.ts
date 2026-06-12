import { z } from "zod";
import {
  emitWorkflowPlanned,
  emitWorkflowStarted,
} from "../runtime/events/events";
import { dispatchHooks } from "../runtime/hooks";
import { runWorkflowStartLifecycle } from "../runtime/workflow-lifecycle";
import { createRunnerLifecycleContext } from "./lifecycle-context";

interface OutputStream {
  write(chunk: string | Uint8Array): boolean;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const runnerLifecycleOptionsSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    fetch: z
      .custom<FetchLike>((value) => typeof value === "function")
      .optional(),
    payloadFile: z.string().min(1),
    phase: z.literal("workflow.start"),
    scheduleFile: z.string().min(1),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
  })
  .strict();

export type RunnerLifecycleOptions = z.input<
  typeof runnerLifecycleOptionsSchema
>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

export async function runRunnerLifecycle(
  rawOptions: Partial<RunnerLifecycleOptions> = {}
): Promise<number> {
  const parsedOptions = runnerLifecycleOptionsSchema.safeParse(rawOptions);
  const stderr = rawOptions.stderr ?? process.stderr;
  if (!parsedOptions.success) {
    stderr.write(`${parsedOptions.error.message}\n`);
    return EXIT_VALIDATION;
  }
  const options = parsedOptions.data;
  try {
    const { context, sink } = await createRunnerLifecycleContext(options);
    const failure = await runWorkflowStartLifecycle({
      emitWorkflowPlanned: () => emitWorkflowPlanned(context),
      emitWorkflowStarted: () => emitWorkflowStarted(context),
      runWorkflowHook: (event) => dispatchHooks(context, event),
    });
    await flushAndReport(sink, stderr);
    return failure ? EXIT_FAIL : EXIT_PASS;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return error instanceof z.ZodError ? EXIT_VALIDATION : EXIT_STARTUP;
  }
}

function isOutputStream(value: unknown): value is OutputStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "write" in value &&
    typeof value.write === "function"
  );
}

async function flushAndReport(
  sink: Awaited<ReturnType<typeof createRunnerLifecycleContext>>["sink"],
  stderr: OutputStream
): Promise<void> {
  try {
    await sink.flush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`runner event flush failed: ${message}\n`);
  }
}
