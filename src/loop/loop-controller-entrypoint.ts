import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config";
import {
  parseRunnerCommandPayload,
  resolveRunnerEventSinkAuthToken,
} from "../runner-command-contract";
import { runLoopController } from "./controller";
import {
  buildControllerDeps,
  type LoopControllerContext,
} from "./controller-deps";
import type { LoopFlags } from "./loop-command";

// ===========================================================================
// PIPE-88.8 — in-cluster `moka loop-controller` entrypoint
//
// Runs inside the submitted cloud command workflow. It reads the runner command
// payload (repository / run / event sink) the runner mounted, resolves the
// event auth token, layers the controller flags + pod-provided secret names,
// and drives `runLoopController` with the production `ControllerDeps`.
// ===========================================================================

export interface LoopControllerEntrypointOptions {
  readonly flags: LoopFlags;
  readonly payloadFile: string;
  readonly worktreePath: string;
}

/** Pod-provided submission secret names the controller needs to spawn children. */
interface ControllerSecretEnv {
  readonly brokerSecretKey: string;
  readonly brokerSecretName: string;
  readonly gitCredentialsSecretName: string;
  readonly githubAuthSecretName?: string;
  readonly serviceAccountName?: string;
}

export function runLoopControllerEntrypoint(
  options: LoopControllerEntrypointOptions
): Promise<void> {
  const payload = parseRunnerCommandPayload(
    readFileSync(options.payloadFile, "utf8")
  );
  const config = loadPipelineConfig(options.worktreePath, {
    allowMissingLintFileReferences: true,
  });
  const context = buildContext({
    config,
    flags: options.flags,
    payload,
    secrets: requireSecretEnv(process.env),
    worktreePath: options.worktreePath,
  });
  return Effect.runPromise(
    runLoopController(buildControllerDeps(context)).pipe(Effect.asVoid)
  );
}

function buildContext(input: {
  config: PipelineConfig;
  flags: LoopFlags;
  payload: ReturnType<typeof parseRunnerCommandPayload>;
  secrets: ControllerSecretEnv;
  worktreePath: string;
}): LoopControllerContext {
  const { payload } = input;
  return {
    baseBranch: payload.repository.baseBranch,
    brokerAuth: {
      secretKey: input.secrets.brokerSecretKey,
      secretName: input.secrets.brokerSecretName,
      url: requireEnv(process.env, "BROKER_URL"),
    },
    config: input.config,
    eventAuthHeader: payload.events.authHeader,
    eventAuthToken: resolveRunnerEventSinkAuthToken({
      authTokenFile: payload.events.authTokenFile,
    }),
    eventUrl: payload.events.url,
    gitCredentialsSecretName: input.secrets.gitCredentialsSecretName,
    githubAuthSecretName: input.secrets.githubAuthSecretName,
    maxMergePolls: input.flags.maxMergePolls ?? DEFAULT_MAX_MERGE_POLLS,
    maxRemediationAttempts:
      input.flags.maxRemediationAttempts ?? DEFAULT_MAX_REMEDIATION_ATTEMPTS,
    namespace: requireEnv(process.env, "PIPELINE_NAMESPACE"),
    project: payload.run.project,
    rootId: input.flags.rootId,
    runId: payload.run.id,
    serviceAccountName: input.secrets.serviceAccountName,
    strategy: input.flags.strategy,
    url: payload.repository.url,
    worktreePath: input.worktreePath,
  };
}

const DEFAULT_MAX_MERGE_POLLS = 60;
const DEFAULT_MAX_REMEDIATION_ATTEMPTS = 2;

function requireSecretEnv(env: NodeJS.ProcessEnv): ControllerSecretEnv {
  return {
    brokerSecretKey: requireEnv(env, "PIPELINE_BROKER_SECRET_KEY"),
    brokerSecretName: requireEnv(env, "PIPELINE_BROKER_SECRET_NAME"),
    gitCredentialsSecretName: requireEnv(
      env,
      "PIPELINE_GIT_CREDENTIALS_SECRET"
    ),
    githubAuthSecretName: env.PIPELINE_GITHUB_AUTH_SECRET,
    serviceAccountName: env.PIPELINE_SERVICE_ACCOUNT,
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `moka loop-controller requires the ${name} environment variable`
    );
  }
  return value;
}
