import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  PipelineRuntimeEvent,
  PipelineRuntimeOptions,
} from "../pipeline-runtime";
import type { MokaNodeStatus, MokaRunStatus } from "./contracts";
import { updateNodeStatus, updateRunStatus } from "./store";

type RuntimeReporter = NonNullable<PipelineRuntimeOptions["reporter"]>;

export interface CreateRunStoreRuntimeReporterInput {
  now?: () => Date;
  reporter?: PipelineRuntimeOptions["reporter"];
  runId: string;
  workspaceRoot: string;
}

export interface RunStoreRuntimeReporter {
  flush: () => Promise<void>;
  reporter: RuntimeReporter;
}

const RUNS_DIRECTORY = ".pipeline/runs";
const RUNTIME_EVENTS_FILE = "runtime-events.jsonl";
const NODES_DIRECTORY = "nodes";
const STDOUT_ARTIFACT = "stdout.jsonl";

export function createRunStoreRuntimeReporter(
  input: CreateRunStoreRuntimeReporterInput
): RunStoreRuntimeReporter {
  const now = input.now ?? (() => new Date());
  const observedNodeStatuses = new Map<string, MokaNodeStatus>();
  const activeHookPreviousStatuses = new Map<string, MokaNodeStatus>();
  let writeChain: Promise<void> = Promise.resolve();

  const enqueue = (event: PipelineRuntimeEvent): void => {
    const projection = projectRuntimeEvent(event, {
      activeHookPreviousStatuses,
      observedNodeStatuses,
    });
    writeChain = writeChain.then(() =>
      persistRuntimeEvent(input, event, projection, now)
    );
  };

  return {
    flush: () => writeChain,
    reporter(event) {
      enqueue(event);
      input.reporter?.(event);
    },
  };
}

interface ProjectionState {
  activeHookPreviousStatuses: Map<string, MokaNodeStatus>;
  observedNodeStatuses: Map<string, MokaNodeStatus>;
}

interface RuntimeEventProjection {
  node?: {
    nodeId: string;
    status: MokaNodeStatus;
  };
  run?: MokaRunStatus;
}

async function persistRuntimeEvent(
  input: CreateRunStoreRuntimeReporterInput,
  event: PipelineRuntimeEvent,
  projection: RuntimeEventProjection,
  now: () => Date
): Promise<void> {
  await appendRuntimeEvent(input, event);

  if (projection.run) {
    await updateRunStatus({
      at: timestamp(now),
      runId: input.runId,
      status: projection.run,
      workspaceRoot: input.workspaceRoot,
    });
  }

  if (projection.node) {
    await updateNodeStatus({
      at: timestamp(now),
      nodeId: projection.node.nodeId,
      runId: input.runId,
      status: projection.node.status,
      workspaceRoot: input.workspaceRoot,
    });
  }

  if (event.type === "node.output.recorded") {
    await appendNodeStdout(input, event.nodeId, event);
  }
}

function projectRuntimeEvent(
  event: PipelineRuntimeEvent,
  state: ProjectionState
): RuntimeEventProjection {
  const projection = projectRunStatus(event) ?? projectNodeStatus(event, state);

  if (projection?.node) {
    state.observedNodeStatuses.set(
      projection.node.nodeId,
      projection.node.status
    );
  }

  return projection ?? {};
}

function projectRunStatus(
  event: PipelineRuntimeEvent
): RuntimeEventProjection | null {
  switch (event.type) {
    case "workflow.start":
      return { run: "starting" };
    case "workflow.finish":
      return { run: workflowOutcomeStatus(event.outcome) };
    default:
      return null;
  }
}

function projectNodeStatus(
  event: PipelineRuntimeEvent,
  state: ProjectionState
): RuntimeEventProjection | null {
  switch (event.type) {
    case "node.start":
      return nodeProjection(event.nodeId, "running");
    case "node.finish":
      return nodeProjection(event.nodeId, runtimeNodeStatus(event.status));
    case "agent.start":
      return nodeProjection(event.nodeId, "running");
    case "agent.finish":
      return nodeProjection(event.nodeId, agentFinishStatus(event.exitCode));
    case "gate.start":
      return nodeProjection(event.nodeId, "running");
    case "gate.finish":
      return nodeProjection(event.nodeId, event.passed ? "running" : "blocked");
    case "hook.start":
      return projectHookStart(event, state);
    case "hook.finish":
      return projectHookFinish(event, state);
    default:
      return null;
  }
}

function projectHookStart(
  event: Extract<PipelineRuntimeEvent, { type: "hook.start" }>,
  state: ProjectionState
): RuntimeEventProjection | null {
  if (!event.nodeId) {
    return null;
  }

  const previous = state.observedNodeStatuses.get(event.nodeId);
  if (previous) {
    state.activeHookPreviousStatuses.set(event.hookId, previous);
  }

  return nodeProjection(event.nodeId, "running");
}

function projectHookFinish(
  event: Extract<PipelineRuntimeEvent, { type: "hook.finish" }>,
  state: ProjectionState
): RuntimeEventProjection | null {
  if (!event.nodeId) {
    return null;
  }

  const previousStatus = state.activeHookPreviousStatuses.get(event.hookId);
  state.activeHookPreviousStatuses.delete(event.hookId);

  if (!event.passed && event.required) {
    return nodeProjection(event.nodeId, "blocked");
  }

  return nodeProjection(event.nodeId, previousStatus ?? "running");
}

function nodeProjection(
  nodeId: string,
  status: MokaNodeStatus
): RuntimeEventProjection {
  return {
    node: {
      nodeId,
      status,
    },
  };
}

function workflowOutcomeStatus(
  outcome: Extract<PipelineRuntimeEvent, { type: "workflow.finish" }>["outcome"]
): MokaRunStatus {
  switch (outcome) {
    case "PASS":
      return "passed";
    case "FAIL":
      return "failed";
    case "CANCELLED":
      return "aborted";
    default:
      return assertNever(outcome);
  }
}

function runtimeNodeStatus(
  status: Extract<PipelineRuntimeEvent, { type: "node.finish" }>["status"]
): MokaNodeStatus {
  switch (status) {
    case "failed":
      return "failed";
    case "passed":
      return "passed";
    default:
      return assertNever(status);
  }
}

function agentFinishStatus(exitCode: number): MokaNodeStatus {
  return exitCode === 0 ? "running" : "failed";
}

async function appendRuntimeEvent(
  input: CreateRunStoreRuntimeReporterInput,
  event: PipelineRuntimeEvent
): Promise<void> {
  const runRoot = runDirectory(input.workspaceRoot, input.runId);
  await mkdir(runRoot, { recursive: true });
  await appendJsonl(join(runRoot, RUNTIME_EVENTS_FILE), event);
}

async function appendNodeStdout(
  input: CreateRunStoreRuntimeReporterInput,
  nodeId: string,
  event: Extract<PipelineRuntimeEvent, { type: "node.output.recorded" }>
): Promise<void> {
  const nodeRoot = join(
    runDirectory(input.workspaceRoot, input.runId),
    NODES_DIRECTORY,
    logicalSegment("nodeId", nodeId)
  );
  await mkdir(nodeRoot, { recursive: true });
  await appendJsonl(join(nodeRoot, STDOUT_ARTIFACT), event);
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function runDirectory(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, RUNS_DIRECTORY, logicalSegment("runId", runId));
}

function logicalSegment(label: string, value: string): string {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} must be a non-empty logical identifier.`);
  }

  return value;
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime reporter value: ${String(value)}`);
}
