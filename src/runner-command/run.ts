import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";
import pino from "pino";
import { z } from "zod";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import { runScheduledWorkflowTask } from "../pipeline-runtime";
import { findPlannedNode } from "../planned-node";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../planning/generate";
import {
  commitAndPushNodeRef,
  mergeDependencyRefs,
  prepareRunnerGitWorkspace,
} from "../run-state/git-refs";
import {
  parseRunnerCommandPayload,
  RunnerCommandPayloadValidationError,
  type RunnerTask,
  resolveRunnerEventSinkAuthToken,
} from "../runner-command-contract";
import { createRunnerEventSink } from "../runner-event-sink";
import type { RuntimeNodeResult } from "../runtime/contracts";
import {
  DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH,
  readRunnerTaskDescriptor,
} from "./task-descriptor";

interface OutputStream {
  write(chunk: string | Uint8Array): void;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const runnerCommandOptionsSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    fetch: z
      .custom<FetchLike>((value) => typeof value === "function")
      .optional(),
    payloadFile: z.string().min(1),
    scheduleFile: z.string().min(1),
    stderr: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    stdout: z.custom<OutputStream>((value) => isOutputStream(value)).optional(),
    taskDescriptorFile: z.string().min(1).optional(),
  })
  .strict();

export type RunnerCommandOptions = z.input<typeof runnerCommandOptionsSchema>;

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_VALIDATION = 64;
const EXIT_STARTUP = 70;

export async function runRunnerCommand(
  rawOptions: Partial<RunnerCommandOptions> = {}
): Promise<number> {
  const parsedOptions = runnerCommandOptionsSchema.safeParse(rawOptions);
  const stderr = isOutputStream(rawOptions.stderr)
    ? rawOptions.stderr
    : process.stderr;
  const stdout = isOutputStream(rawOptions.stdout)
    ? rawOptions.stdout
    : process.stdout;
  const logger = createRunnerLogger({ stderr, stdout });
  if (!parsedOptions.success) {
    logger.error(
      { error: parsedOptions.error.message, phase: "options.validate" },
      "runner options validation failed"
    );
    return EXIT_VALIDATION;
  }
  const options = parsedOptions.data;
  try {
    logger.info(
      { phase: "payload.load", status: "start" },
      "payload.load start"
    );
    const payload = parseRunnerCommandPayload(
      readFileSync(options.payloadFile, "utf8")
    );
    const descriptor = readRunnerTaskDescriptor(
      options.taskDescriptorFile ?? DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH
    );
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "payload.load",
        runId: payload.run.id,
        status: "finish",
        workflowId: payload.workflow.id,
      },
      "payload.load finish"
    );
    logger.info(
      { phase: "event.sink.configure", status: "start" },
      "event.sink.configure start"
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
    logger.info(
      { phase: "event.sink.configure", status: "finish" },
      "event.sink.configure finish"
    );
    logger.info(
      {
        hasProvidedCwd: Boolean(options.cwd),
        phase: "git.workspace.prepare",
        status: "start",
      },
      "git.workspace.prepare start"
    );
    const worktreePath = await prepareRunnerGitWorkspace(payload, {
      cwd: options.cwd,
    });
    logger.info(
      { phase: "git.workspace.prepare", status: "finish" },
      "git.workspace.prepare finish"
    );
    logger.info({ phase: "config.load", status: "start" }, "config.load start");
    const baseConfig = loadPipelineConfig(worktreePath, {
      allowMissingLintFileReferences: true,
    });
    logger.info(
      { phase: "config.load", status: "finish" },
      "config.load finish"
    );
    logger.info(
      { phase: "schedule.compile", status: "start" },
      "schedule.compile start"
    );
    const compiled = compileScheduleArtifact(
      baseConfig,
      parseScheduleArtifact(
        readFileSync(options.scheduleFile, "utf8"),
        options.scheduleFile
      ),
      worktreePath
    );
    logger.info(
      {
        phase: "schedule.compile",
        status: "finish",
        workflowId: compiled.workflowId,
      },
      "schedule.compile finish"
    );
    if (payload.workflow.id !== compiled.workflowId) {
      throw new Error(
        `Runner payload workflow '${payload.workflow.id}' does not match schedule workflow '${compiled.workflowId}'`
      );
    }
    const node = findPlannedNode(
      compiled.plan.topologicalOrder,
      descriptor.nodeId
    );
    if (!node) {
      throw new Error(
        `Argo task '${descriptor.nodeId}' is not declared in workflow '${compiled.workflowId}'`
      );
    }
    logger.info(
      {
        dependencyCount: node.needs.length,
        nodeId: descriptor.nodeId,
        phase: "dependency.merge",
        status: "start",
      },
      "dependency.merge start"
    );
    await mergeDependencyRefs({
      committer: compiled.config.runner_command.git.committer,
      dependencyNodeIds: node.needs,
      payload,
      worktreePath,
    });
    logger.info(
      {
        dependencyCount: node.needs.length,
        nodeId: descriptor.nodeId,
        phase: "dependency.merge",
        status: "finish",
      },
      "dependency.merge finish"
    );
    logger.info(
      {
        commandCount: baseConfig.runner_command.environment.setup.length,
        phase: "setup.commands",
        status: "start",
      },
      "setup.commands start"
    );
    await runSetupCommands(baseConfig.runner_command.environment.setup, {
      env: options.env ?? process.env,
      logger,
      worktreePath,
    });
    logger.info(
      {
        commandCount: baseConfig.runner_command.environment.setup.length,
        phase: "setup.commands",
        status: "finish",
      },
      "setup.commands finish"
    );
    sink.recordRunnerCommandPhase(
      "task.start",
      `Starting ${descriptor.nodeId}`,
      {
        kind: node.kind,
        taskId: descriptor.nodeId,
        workflowId: payload.workflow.id,
      }
    );
    logger.info(
      {
        kind: node.kind,
        nodeId: descriptor.nodeId,
        phase: "task.run",
        status: "start",
      },
      "task.run start"
    );
    const result = await runScheduledWorkflowTask({
      config: compiled.config,
      hookPolicy: payload.hookPolicy,
      nodeId: descriptor.nodeId,
      reporter: (event) => sink.recordRuntimeEvent(event),
      runId: payload.run.id,
      task: runnerTaskText(payload.task, worktreePath),
      workflowId: compiled.workflowId,
      worktreePath,
    });
    logger.info(
      {
        exitCode: result.exitCode,
        nodeId: descriptor.nodeId,
        phase: "task.run",
        resultStatus: result.status,
        status: "finish",
      },
      "task.run finish"
    );
    logFailedTaskRun(logger, descriptor.nodeId, result);
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "git.node-ref.push",
        status: "start",
      },
      "git.node-ref.push start"
    );
    await commitAndPushNodeRef({
      committer: compiled.config.runner_command.git.committer,
      nodeId: descriptor.nodeId,
      payload,
      worktreePath,
    });
    logger.info(
      {
        nodeId: descriptor.nodeId,
        phase: "git.node-ref.push",
        status: "finish",
      },
      "git.node-ref.push finish"
    );
    sink.recordRunnerCommandPhase(
      "task.finish",
      `Finished ${descriptor.nodeId}`,
      {
        evidence: result.evidence,
        exitCode: result.exitCode,
        output: result.output,
        taskId: descriptor.nodeId,
        workflowId: payload.workflow.id,
      }
    );
    await flushAndReport(sink, logger);
    return result.status === "passed" ? EXIT_PASS : EXIT_FAIL;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, phase: "runner-command" }, message);
    return error instanceof RunnerCommandPayloadValidationError ||
      error instanceof z.ZodError
      ? EXIT_VALIDATION
      : EXIT_STARTUP;
  }
}

async function runSetupCommands(
  commands: PipelineConfig["runner_command"]["environment"]["setup"],
  options: {
    env: Record<string, string | undefined>;
    logger: pino.Logger;
    worktreePath: string;
  }
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    options.logger.info(
      {
        command: command.command,
        index: index + 1,
        phase: "setup.command",
        status: "start",
      },
      "setup.command start"
    );
    const result = await execa(command.command, command.args, {
      cwd: options.worktreePath,
      env: options.env,
      reject: false,
    });
    options.logger.info(
      {
        command: command.command,
        exitCode: result.exitCode,
        index: index + 1,
        phase: "setup.command",
        required: command.required,
        status: "finish",
      },
      "setup.command finish"
    );
    if (result.exitCode !== 0 && command.required) {
      throw new Error(
        `runner setup command '${command.command}' failed with exit ${result.exitCode}`
      );
    }
  }
}

function logFailedTaskRun(
  logger: pino.Logger,
  nodeId: string,
  result: RuntimeNodeResult
): void {
  if (result.status === "passed" && result.exitCode === 0) {
    return;
  }
  logger.error(
    {
      evidence: result.evidence,
      exitCode: result.exitCode,
      nodeId,
      output: result.output,
      phase: "task.run",
      resultStatus: result.status,
      status: "failed",
    },
    "task.run failed"
  );
}

export function runnerTaskText(task: RunnerTask, worktreePath: string): string {
  if (task.kind === "prompt") {
    return task.prompt;
  }
  if (task.path) {
    return readFileSync(resolve(worktreePath, task.path), "utf8");
  }
  return [task.id, task.title].filter(Boolean).join(" ");
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
  logger: pino.Logger
): Promise<void> {
  logger.info({ phase: "event.flush", status: "start" }, "event.flush start");
  try {
    await sink.flush();
    logger.info(
      { phase: "event.flush", status: "finish" },
      "event.flush finish"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { error: message, phase: "event.flush" },
      `runner event flush failed: ${message}`
    );
  }
}

function createRunnerLogger(options: {
  stderr: OutputStream;
  stdout: OutputStream;
}): pino.Logger {
  const streams: pino.StreamEntry[] = [
    { level: "info", stream: options.stdout },
    { level: "error", stream: options.stderr },
  ];
  return pino(
    {
      base: undefined,
      level: "info",
      name: "moka-runner",
      redact: {
        censor: "[redacted]",
        paths: [
          "authToken",
          "*.authToken",
          "token",
          "*.token",
          "password",
          "*.password",
          "identity",
          "*.identity",
        ],
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams, { dedupe: true })
  );
}
