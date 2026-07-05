import { Option } from "commander";
import type { Command } from "commander";

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

export const registerLoopCommand = (program: Command): void => {
  program
    .command("loop")
    .description(
      "Submit a long-running cloud controller that drains the backlog ticket-by-ticket"
    )
    .addOption(
      new Option("--strategy <strategy>", "ready-ticket selection strategy")
        .choices(["priority", "bfs", "dfs"])
        .default("priority")
    )
    .option("--root <epic-id>", "restrict traversal to this epic subtree")
    .option(
      "--max-remediation-attempts <n>",
      "bounded fix-up submits before a PR is declared blocked"
    )
    .option(
      "--merge-timeout <n>",
      "bounded merge polls before an indeterminate PR is declared blocked"
    )
    .action(async (options: LoopCommandOptions) => {
      const result = await runLoopSubmit(buildLoopSubmitInput(options));
      console.log(
        `Loop controller submitted: ${result.workflowName} in ${result.namespace}`
      );
    });

  program
    .command("loop-controller", { hidden: true })
    .description("Internal in-cluster loop controller process")
    .requiredOption("--payload-file <path>", "Path to the runner payload JSON")
    .addOption(
      new Option("--strategy <strategy>", "ready-ticket selection strategy")
        .choices(["priority", "bfs", "dfs"])
        .default("priority")
    )
    .option("--root <epic-id>", "restrict traversal to this epic subtree")
    .option("--max-remediation-attempts <n>", "bounded fix-up submits")
    .option("--merge-timeout <n>", "bounded merge polls")
    .action(async (flags: LoopControllerEntrypointFlags) => {
      await runLoopControllerEntrypoint({
        flags: parseLoopFlags(flags),
        payloadFile: flags.payloadFile,
        worktreePath: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
      });
    });
};
