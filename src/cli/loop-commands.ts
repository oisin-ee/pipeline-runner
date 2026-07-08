import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { loadPipelineConfig } from "../config";
import { parseLoopFlags, runLoopSubmit } from "../loop/loop-command";
import type { LoopCommandOptions } from "../loop/loop-command";
import { runLoopControllerEntrypoint } from "../loop/loop-controller-entrypoint";
import { loadMokaGlobalConfig } from "../moka-global-config";

interface LoopControllerEntrypointFlags {
  maxRemediationAttempts?: string;
  mergeTimeout?: string;
  payloadFile: string;
  root?: string;
  strategy?: string;
}

const loopFlags = {
  maxRemediationAttempts: Flag.string("max-remediation-attempts").pipe(
    Flag.withDescription(
      "bounded fix-up submits before a PR is declared blocked"
    ),
    Flag.optional
  ),
  mergeTimeout: Flag.string("merge-timeout").pipe(
    Flag.withDescription(
      "bounded merge polls before an indeterminate PR is declared blocked"
    ),
    Flag.optional
  ),
  root: Flag.string("root").pipe(
    Flag.withDescription("restrict traversal to this epic subtree"),
    Flag.optional
  ),
  strategy: Flag.choice("strategy", ["priority", "bfs", "dfs"]).pipe(
    Flag.withDescription("ready-ticket selection strategy"),
    Flag.withDefault("priority")
  ),
};

const loopControllerFlags = {
  ...loopFlags,
  payloadFile: Flag.string("payload-file").pipe(
    Flag.withDescription("Path to the runner payload JSON")
  ),
};

const normalizeLoopFlags = (
  flags: Command.Command.Config.Infer<typeof loopFlags>
): LoopCommandOptions => ({
  maxRemediationAttempts: Option.getOrUndefined(flags.maxRemediationAttempts),
  mergeTimeout: Option.getOrUndefined(flags.mergeTimeout),
  root: Option.getOrUndefined(flags.root),
  strategy: flags.strategy,
});

const normalizeLoopControllerFlags = (
  flags: Command.Command.Config.Infer<typeof loopControllerFlags>
): LoopControllerEntrypointFlags => ({
  ...normalizeLoopFlags(flags),
  payloadFile: flags.payloadFile,
});

const buildLoopSubmitInput = (
  options: LoopCommandOptions
): Parameters<typeof runLoopSubmit>[0] => {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const config = loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
  const globalConfig = loadMokaGlobalConfig();
  if (globalConfig === null) {
    throw new Error(
      "momokaya.submit.brokerAuth is required for moka loop submit"
    );
  }
  const { momokaya } = globalConfig;
  return {
    brokerAuth: momokaya.submit.brokerAuth,
    config,
    eventUrl: momokaya.submit.eventUrl,
    flags: parseLoopFlags(options),
    gitCredentialsSecretName: momokaya.submit.gitCredentialsSecretName,
    githubAuthSecretName: momokaya.submit.githubAuthSecretName,
    kubeconfigPath: momokaya.kubernetes.kubeconfig,
    namespace: momokaya.kubernetes.namespace,
    serviceAccountName: momokaya.submit.serviceAccountName,
    worktreePath: cwd,
  };
};

const loopCommand = Command.make("loop", loopFlags, (rawFlags) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      await runLoopSubmit(buildLoopSubmitInput(normalizeLoopFlags(rawFlags)));
    },
  })
).pipe(
  Command.withDescription(
    "Submit a long-running cloud controller that drains the backlog ticket-by-ticket"
  )
);

const loopControllerCommand = Command.make(
  "loop-controller",
  loopControllerFlags,
  (rawFlags) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const flags = normalizeLoopControllerFlags(rawFlags);
        await runLoopControllerEntrypoint({
          flags: parseLoopFlags(flags),
          payloadFile: flags.payloadFile,
          worktreePath: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
        });
      },
    })
).pipe(
  Command.withDescription("Internal in-cluster loop controller process"),
  Command.withHidden
);

export const createLoopCommands = () => [loopCommand, loopControllerCommand];
