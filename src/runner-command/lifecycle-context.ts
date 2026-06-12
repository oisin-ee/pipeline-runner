import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadPipelineConfig,
  PIPELINE_CONFIG_PATH,
  PROFILES_CONFIG_PATH,
  parsePipelineConfigParts,
  RUNNERS_CONFIG_PATH,
} from "../config";
import { prepareRunnerGitWorkspace } from "../run-state/git-refs";
import {
  parseRunnerCommandPayload,
  resolveRunnerEventSinkAuthToken,
} from "../runner-command-contract";
import { createRunnerEventSink } from "../runner-event-sink";
import type { RuntimeContext } from "../runtime/contracts";
import { initialNodeStateStore } from "../runtime/node-state-store";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "../schedule-planner";
import { runnerTaskText } from "./run";

interface RunnerLifecycleContextOptions {
  cwd?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  payloadFile: string;
  scheduleFile: string;
}

export async function createRunnerLifecycleContext(
  options: RunnerLifecycleContextOptions
): Promise<RunnerLifecycleContext> {
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
  const config = loadRunnerLifecycleConfig(worktreePath);
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

  const context: RuntimeContext = {
    agentInvocations: [],
    config: compiled.config,
    executor: () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: payload.hookPolicy?.allowCommandHooks ?? true,
      allowUntrustedCommandHooks:
        payload.hookPolicy?.allowUntrustedCommandHooks ?? true,
      env: payload.hookPolicy?.env ?? {},
      envPassthrough: payload.hookPolicy?.envPassthrough ?? ["PATH"],
      outputLimitBytes: payload.hookPolicy?.outputLimitBytes ?? 64 * 1024,
      timeoutMs: payload.hookPolicy?.timeoutMs ?? 30_000,
    },
    hookResults: new Map(),
    nodeStateStore: initialNodeStateStore(compiled.plan),
    plan: compiled.plan,
    reporter: (event) => sink.recordRuntimeEvent(event),
    runId: payload.run.id,
    task: runnerTaskText(payload.task, worktreePath),
    workflowId: compiled.workflowId,
    worktreePath,
  };

  return { compiled, context, payload, sink, worktreePath };
}

function loadRunnerLifecycleConfig(worktreePath: string) {
  const pipelinePath = join(worktreePath, PIPELINE_CONFIG_PATH);
  const profilesPath = join(worktreePath, PROFILES_CONFIG_PATH);
  const runnersPath = join(worktreePath, RUNNERS_CONFIG_PATH);
  if (
    existsSync(pipelinePath) &&
    existsSync(profilesPath) &&
    existsSync(runnersPath)
  ) {
    return parsePipelineConfigParts(
      {
        pipeline: readFileSync(pipelinePath, "utf8"),
        profiles: readFileSync(profilesPath, "utf8"),
        runners: readFileSync(runnersPath, "utf8"),
      },
      worktreePath,
      {
        pipeline: PIPELINE_CONFIG_PATH,
        profiles: PROFILES_CONFIG_PATH,
        runners: RUNNERS_CONFIG_PATH,
      },
      { allowMissingLintFileReferences: true }
    );
  }
  return loadPipelineConfig(worktreePath, {
    allowMissingLintFileReferences: true,
  });
}

export interface RunnerLifecycleContext {
  compiled: ReturnType<typeof compileScheduleArtifact>;
  context: RuntimeContext;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  sink: ReturnType<typeof createRunnerEventSink>;
  worktreePath: string;
}
