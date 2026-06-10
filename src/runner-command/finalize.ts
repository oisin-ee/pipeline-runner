import { readFileSync } from "node:fs";
import { z } from "zod";
import { compileArgoExecutionGraph } from "../argo-graph";
import { loadPipelineConfig } from "../config";
import {
  prepareRunnerGitWorkspace,
  promoteFinalRef,
} from "../run-state/git-refs";
import {
  parseRunnerCommandPayload,
  RunnerCommandPayloadValidationError,
  resolveRunnerEventSinkAuthToken,
} from "../runner-command-contract";
import { createRunnerEventSink } from "../runner-event-sink";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../schedule-planner";

interface OutputStream {
  write(chunk: string | Uint8Array): boolean;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const runnerFinalizeOptionsSchema = z
  .object({
    argoStatus: z.string().min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    fetch: z
      .custom<FetchLike>((value) => typeof value === "function")
      .optional(),
    payloadFile: z.string().min(1),
    scheduleFile: z.string().min(1),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
  })
  .strict();

export type RunnerFinalizeOptions = z.input<typeof runnerFinalizeOptionsSchema>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

export async function runRunnerFinalize(
  rawOptions: Partial<RunnerFinalizeOptions> = {}
): Promise<number> {
  const parsedOptions = runnerFinalizeOptionsSchema.safeParse(rawOptions);
  const stderr = rawOptions.stderr ?? process.stderr;
  if (!parsedOptions.success) {
    stderr.write(`${parsedOptions.error.message}\n`);
    return EXIT_VALIDATION;
  }
  const options = parsedOptions.data;
  try {
    const payload = parseRunnerCommandPayload(
      readFileSync(options.payloadFile, "utf8")
    );
    const authToken = resolveRunnerEventSinkAuthToken({
      authTokenFile: payload.events.authTokenFile,
    });
    const sink = createRunnerEventSink({
      authHeader: payload.events.authHeader,
      authToken,
      fetch: options.fetch,
      runId: payload.run.id,
      url: payload.events.url,
    });
    const worktreePath = await prepareRunnerGitWorkspace(payload, {
      cwd: options.cwd,
    });
    const config = loadPipelineConfig(worktreePath, {
      allowMissingLintFileReferences: true,
    });
    const compiled = compileScheduleArtifact(
      config,
      parseScheduleArtifact(
        readFileSync(options.scheduleFile, "utf8"),
        options.scheduleFile
      ),
      worktreePath
    );
    if (payload.workflow.id !== compiled.workflowId) {
      throw new Error(
        `Runner payload workflow '${payload.workflow.id}' does not match schedule workflow '${compiled.workflowId}'`
      );
    }
    if (options.argoStatus === "Succeeded") {
      const graph = compileArgoExecutionGraph(compiled.plan);
      await promoteFinalRef({
        committer: compiled.config.runner_command.git.committer,
        payload,
        sourceNodeIds: graph.terminalNodeIds,
        worktreePath,
      });
      sink.recordFinalResult("PASS", payload.workflow.id);
    } else {
      sink.recordFinalResult("FAIL", payload.workflow.id);
    }
    await flushAndReport(sink, stderr);
    return options.argoStatus === "Succeeded" ? EXIT_PASS : EXIT_FAIL;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return error instanceof RunnerCommandPayloadValidationError ||
      error instanceof z.ZodError
      ? EXIT_VALIDATION
      : EXIT_STARTUP;
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
  sink: ReturnType<typeof createRunnerEventSink>,
  stderr: OutputStream
): Promise<void> {
  try {
    await sink.flush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`runner event flush failed: ${message}\n`);
  }
}
