import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { loadPipelineConfig, type PipelineConfig } from "../config";
import { runScheduledWorkflowTask } from "../pipeline-runtime";
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
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../schedule-planner";
import type { PlannedWorkflowNode } from "../workflow-planner";
import {
  DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH,
  readRunnerTaskDescriptor,
} from "./task-descriptor";

interface OutputStream {
  write(chunk: string | Uint8Array): boolean;
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
    const descriptor = readRunnerTaskDescriptor(
      options.taskDescriptorFile ?? DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH
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
    const baseConfig = loadPipelineConfig(worktreePath, {
      allowMissingLintFileReferences: true,
    });
    const compiled = compileScheduleArtifact(
      baseConfig,
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
    const node = findPlannedNode(
      compiled.plan.topologicalOrder,
      descriptor.nodeId
    );
    if (!node) {
      throw new Error(
        `Argo task '${descriptor.nodeId}' is not declared in workflow '${compiled.workflowId}'`
      );
    }
    await mergeDependencyRefs({
      committer: compiled.config.runner_command.git.committer,
      dependencyNodeIds: node.needs,
      payload,
      worktreePath,
    });
    await runSetupCommands(baseConfig.runner_command.environment.setup, {
      env: options.env ?? process.env,
      worktreePath,
    });
    sink.recordRunnerCommandPhase(
      "task.start",
      `Starting ${descriptor.nodeId}`,
      {
        kind: node.kind,
        taskId: descriptor.nodeId,
        workflowId: payload.workflow.id,
      }
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
    await commitAndPushNodeRef({
      committer: compiled.config.runner_command.git.committer,
      nodeId: descriptor.nodeId,
      payload,
      worktreePath,
    });
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
    await flushAndReport(sink, stderr);
    return result.status === "passed" ? EXIT_PASS : EXIT_FAIL;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    return error instanceof RunnerCommandPayloadValidationError ||
      error instanceof z.ZodError
      ? EXIT_VALIDATION
      : EXIT_STARTUP;
  }
}

function findPlannedNode(
  nodes: PlannedWorkflowNode[],
  nodeId: string
): PlannedWorkflowNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node;
    }
    const child = findPlannedNode(node.children ?? [], nodeId);
    if (child) {
      return child;
    }
  }
  return;
}

async function runSetupCommands(
  commands: PipelineConfig["runner_command"]["environment"]["setup"],
  options: {
    env: Record<string, string | undefined>;
    worktreePath: string;
  }
): Promise<void> {
  for (const command of commands) {
    const result = await execa(command.command, command.args, {
      cwd: options.worktreePath,
      env: options.env,
      reject: false,
    });
    if (result.exitCode !== 0 && command.required) {
      throw new Error(
        `runner setup command '${command.command}' failed with exit ${result.exitCode}`
      );
    }
  }
}

function runnerTaskText(task: RunnerTask, worktreePath: string): string {
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
  stderr: OutputStream
): Promise<void> {
  try {
    await sink.flush();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`runner event flush failed: ${message}\n`);
  }
}
