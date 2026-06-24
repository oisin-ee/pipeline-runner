import { type Command, Option } from "commander";
import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config";
import {
  loadMokaGlobalConfig,
  type MokaGlobalConfig,
} from "../moka-global-config";
import { submitMoka } from "../moka-submit";

interface ArgoCommandOptionOptions {
  kubeconfig?: boolean;
}

export interface MokaSubmitFlags {
  command?: boolean;
  eventUrl?: string;
  generateName?: string;
  image?: string;
  imagePullPolicy?: string;
  imagePullSecret?: string;
  kubeconfig?: string;
  name?: string;
  namespace?: string;
  openPr?: boolean;
  quick?: boolean;
  schedule?: string;
  serviceAccount?: string;
  task?: string;
}

type MokaSubmitInput = Parameters<typeof submitMoka>[0];
type MokaSubmitCommonOptions = Omit<
  MokaSubmitInput,
  "commandArgv" | "mode" | "schedulePath" | "task" | "type"
>;

export function addMokaSubmitOptions(command: Command): Command {
  return addRunnerArgoOptions(
    command
      .option("--quick", "submit the compact graph")
      .option("--command", "treat input after -- as explicit argv")
      .option("--schedule <path>", "approved schedule YAML to submit")
      .option("--event-url <url>", "runner event sink URL")
      .option(
        "--open-pr",
        "append an open-pull-request delivery node (preview-labelled PR)"
      )
      .option("--task <text>", "task description for command-mode metadata"),
    {
      kubeconfig: true,
    }
  );
}

export function runMokaSubmitFromCli(
  input: string[],
  flags: MokaSubmitFlags
): ReturnType<typeof submitMoka> {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const config = loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
  const globalConfig = loadMokaGlobalConfig();
  return submitMoka(
    buildMokaSubmitInputFromCli({ config, cwd, flags, globalConfig, input })
  );
}

export function buildMokaSubmitInputFromCli(input: {
  config: PipelineConfig;
  cwd: string;
  flags: MokaSubmitFlags;
  globalConfig?: MokaGlobalConfig | null;
  input: string[];
}): MokaSubmitInput {
  const commonOptions = mokaCommonSubmitOptions({
    config: input.config,
    cwd: input.cwd,
    eventUrl: resolveMokaEventUrl(input.flags, input.globalConfig),
    flags: input.flags,
    globalConfig: input.globalConfig,
  });
  if (input.flags.command) {
    return submitMokaCommandInput(input.input, input.flags, commonOptions);
  }
  return submitMokaGraphInput(input.input, input.flags, commonOptions);
}

function resolveMokaEventUrl(
  flags: MokaSubmitFlags,
  globalConfig?: MokaGlobalConfig | null
): string | undefined {
  return flags.eventUrl ?? globalConfig?.momokaya.submit.eventUrl;
}

function mokaCommonSubmitOptions(input: {
  config: PipelineConfig;
  cwd: string;
  eventUrl?: string;
  flags: MokaSubmitFlags;
  globalConfig?: MokaGlobalConfig | null;
}): MokaSubmitCommonOptions {
  const momokaya = input.globalConfig?.momokaya;
  return {
    config: input.config,
    delivery: { pullRequest: input.flags.openPr === true },
    eventUrl: input.eventUrl,
    eventAuthSecretKey: momokaya?.submit.eventAuthSecretKey,
    eventAuthSecretName: momokaya?.submit.eventAuthSecretName,
    generateName: input.flags.generateName,
    gitCredentialsSecretName: momokaya?.submit.gitCredentialsSecretName,
    githubAuthSecretName: momokaya?.submit.githubAuthSecretName,
    image: input.flags.image,
    imagePullPolicy: parseImagePullPolicy(input.flags.imagePullPolicy),
    imagePullSecretName:
      input.flags.imagePullSecret ?? momokaya?.submit.imagePullSecretName,
    kubeconfigPath: input.flags.kubeconfig ?? momokaya?.kubernetes.kubeconfig,
    name: input.flags.name,
    namespace: input.flags.namespace ?? momokaya?.kubernetes.namespace,
    brokerAuth: momokaya?.submit.brokerAuth,
    opencodeAuthSecretName: momokaya?.submit.opencodeAuthSecretName,
    opencodeOpenaiAccountsSecretName:
      momokaya?.submit.opencodeOpenaiAccountsSecretName,
    serviceAccountName:
      input.flags.serviceAccount ?? momokaya?.submit.serviceAccountName,
    worktreePath: input.cwd,
  };
}

function submitMokaCommandInput(
  input: string[],
  flags: MokaSubmitFlags,
  commonOptions: MokaSubmitCommonOptions
): MokaSubmitInput {
  if (flags.quick || flags.schedule) {
    throw new Error("--command cannot be combined with --quick or --schedule");
  }
  if (input.length === 0) {
    throw new Error("Command argv is required when --command is set");
  }
  return {
    ...commonOptions,
    commandArgv: input,
    task: flags.task,
    type: "command",
  };
}

function submitMokaGraphInput(
  input: string[],
  flags: MokaSubmitFlags,
  commonOptions: MokaSubmitCommonOptions
): MokaSubmitInput {
  const task = input.join(" ").trim();
  if (!task) {
    throw new Error("Task description is required");
  }
  return {
    ...commonOptions,
    mode: flags.quick ? "quick" : "full",
    schedulePath: flags.schedule,
    task,
    type: "graph",
  };
}

function addRunnerArgoOptions(
  command: Command,
  options: ArgoCommandOptionOptions = {}
): Command {
  command
    .option("--name <name>", "Workflow metadata.name")
    .option("--generate-name <prefix>", "Workflow metadata.generateName")
    .option("--namespace <namespace>", "Workflow namespace");
  if (options.kubeconfig) {
    command.option("--kubeconfig <path>", "kubeconfig path");
  }
  return command
    .option("--service-account <name>", "Workflow service account")
    .option("--image <image>", "runner image")
    .addOption(
      new Option("--image-pull-policy <policy>", "runner image pull policy")
        .choices(["Always", "IfNotPresent", "Never"])
        .default("Always")
    )
    .option("--image-pull-secret <name>", "imagePullSecret name");
}

export function parseImagePullPolicy(
  value: string | undefined
): "Always" | "IfNotPresent" | "Never" {
  if (value === "IfNotPresent" || value === "Never") {
    return value;
  }
  return "Always";
}
