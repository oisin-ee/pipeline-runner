import { Option as CommanderOption } from "commander";
import type { Command } from "commander";
import * as Option from "effect/Option";

import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config";
import { loadMokaGlobalConfig } from "../moka-global-config";
import type { MokaGlobalConfig } from "../moka-global-config";
import { submitMoka } from "../moka-submit";

interface ArgoCommandOptionOptions {
  kubeconfig?: boolean;
}

export interface MokaSubmitFlags {
  command?: boolean;
  dbAuthSecretKey?: string;
  dbAuthSecretName?: string;
  eventUrl?: string;
  generateName?: string;
  image?: string;
  imagePullPolicy?: string;
  imagePullSecret?: string;
  kubeContext?: string;
  kubeconfig?: string;
  mcpGatewayAuthSecretKey?: string;
  mcpGatewayAuthSecretName?: string;
  name?: string;
  namespace?: string;
  npmRegistryAuthSecretName?: string;
  openPr?: boolean;
  quick?: boolean;
  schedule?: string;
  serviceAccount?: string;
  skipDbAuth?: boolean;
  skipMcpGatewayAuth?: boolean;
  skipNpmRegistryAuth?: boolean;
  task?: string;
}

interface SecretRefFlags {
  secretKey?: string;
  secretName?: string;
  skip?: boolean;
}

interface SecretRef {
  secretKey?: string;
  secretName: string;
}

// Same override precedence as kubeContext/kubeconfigPath: CLI flag wins, then
// global config, then absent. dbAuth/mcpGatewayAuth were previously read
// unconditionally from global config with no per-invocation override, which
// breaks the moment you target a cluster that doesn't have that secret name.
const resolveOptionalSecretRef = (
  flags: SecretRefFlags,
  fromGlobalConfig: Option.Option<SecretRef>
): Option.Option<SecretRef> => {
  if (flags.skip === true) {
    return Option.none();
  }
  if (flags.secretName !== undefined && flags.secretName !== "") {
    return Option.some({
      secretName: flags.secretName,
      ...(flags.secretKey !== undefined && flags.secretKey !== ""
        ? { secretKey: flags.secretKey }
        : {}),
    });
  }
  return fromGlobalConfig;
};

interface SecretNameFlags {
  secretName?: string;
  skip?: boolean;
}

// Same override precedence as resolveOptionalSecretRef, for a plain secret-name
// field with no separate key -- the mounted key is fixed (see
// appendNpmRegistryAuthStorage), so there is nothing for a "secret key" flag to
// override.
const resolveOptionalSecretName = (
  flags: SecretNameFlags,
  fromGlobalConfig: Option.Option<string>
): Option.Option<string> => {
  if (flags.skip === true) {
    return Option.none();
  }
  return Option.orElse(
    Option.fromUndefinedOr(flags.secretName),
    () => fromGlobalConfig
  );
};

type MokaSubmitInput = Parameters<typeof submitMoka>[0];
type MokaSubmitCommonOptions = Omit<
  MokaSubmitInput,
  "commandArgv" | "mode" | "schedulePath" | "task" | "type"
>;

const resolveMokaEventUrl = (
  flags: MokaSubmitFlags,
  globalConfig?: MokaGlobalConfig
) => flags.eventUrl ?? globalConfig?.momokaya.submit.eventUrl;

const resolveMokaBrokerAuth = (
  globalConfig?: MokaGlobalConfig
): MokaSubmitCommonOptions["brokerAuth"] => {
  const brokerAuth = globalConfig?.momokaya.submit.brokerAuth;
  if (brokerAuth === undefined) {
    throw new Error("momokaya.submit.brokerAuth is required for remote submit");
  }
  return brokerAuth;
};

const submitMokaCommandInput = (
  input: string[],
  flags: MokaSubmitFlags,
  commonOptions: MokaSubmitCommonOptions
): MokaSubmitInput => {
  if (
    flags.quick === true ||
    (flags.schedule !== undefined && flags.schedule !== "")
  ) {
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
};

const submitMokaGraphInput = (
  input: string[],
  flags: MokaSubmitFlags,
  commonOptions: MokaSubmitCommonOptions
): MokaSubmitInput => {
  const task = input.join(" ").trim();
  if (task === "") {
    throw new Error("Task description is required");
  }
  return {
    ...commonOptions,
    mode: flags.quick === true ? "quick" : "full",
    schedulePath: flags.schedule,
    task,
    type: "graph",
  };
};

const addRunnerArgoOptions = (
  command: Command,
  options: ArgoCommandOptionOptions = {}
): Command => {
  command
    .option("--name <name>", "Workflow metadata.name")
    .option("--generate-name <prefix>", "Workflow metadata.generateName")
    .option("--namespace <namespace>", "Workflow namespace");
  if (options.kubeconfig === true) {
    command
      .option("--kubeconfig <path>", "kubeconfig path")
      .option("--kube-context <name>", "kubeconfig context to target");
  }
  return command
    .option("--service-account <name>", "Workflow service account")
    .option("--image <image>", "runner image")
    .addOption(
      new CommanderOption(
        "--image-pull-policy <policy>",
        "runner image pull policy"
      )
        .choices(["Always", "IfNotPresent", "Never"])
        .default("Always")
    )
    .option("--image-pull-secret <name>", "imagePullSecret name");
};

export const addMokaSubmitOptions = (command: Command): Command =>
  addRunnerArgoOptions(
    command
      .option("--quick", "submit the compact graph")
      .option("--command", "treat input after -- as explicit argv")
      .option("--schedule <path>", "approved schedule YAML to submit")
      .option("--event-url <url>", "runner event sink URL")
      .option(
        "--open-pr",
        "append an open-pull-request delivery node (preview-labelled PR)"
      )
      .option("--task <text>", "task description for command-mode metadata")
      .option(
        "--db-auth-secret-name <name>",
        "override momokaya.submit.dbAuth secret name"
      )
      .option(
        "--db-auth-secret-key <key>",
        "override momokaya.submit.dbAuth secret key"
      )
      .option(
        "--skip-db-auth",
        "omit MOKA_DB_URL injection regardless of global config"
      )
      .option(
        "--mcp-gateway-auth-secret-name <name>",
        "override momokaya.submit.mcpGatewayAuth secret name"
      )
      .option(
        "--mcp-gateway-auth-secret-key <key>",
        "override momokaya.submit.mcpGatewayAuth secret key"
      )
      .option(
        "--skip-mcp-gateway-auth",
        "omit PIPELINE_MCP_GATEWAY_AUTHORIZATION injection regardless of global config"
      )
      .option(
        "--npm-registry-auth-secret-name <name>",
        "override momokaya.submit.npmRegistryAuthSecretName"
      )
      .option(
        "--skip-npm-registry-auth",
        "omit the /root/.npmrc mount regardless of global config"
      ),
    {
      kubeconfig: true,
    }
  );

export const parseImagePullPolicy = (
  value?: string
): "Always" | "IfNotPresent" | "Never" => {
  if (value === "IfNotPresent" || value === "Never") {
    return value;
  }
  return "Always";
};

const mokaCommonSubmitOptions = (input: {
  config: PipelineConfig;
  cwd: string;
  eventUrl?: string;
  flags: MokaSubmitFlags;
  globalConfig?: MokaGlobalConfig;
}): MokaSubmitCommonOptions => {
  const momokaya = input.globalConfig?.momokaya;
  return {
    brokerAuth: resolveMokaBrokerAuth(input.globalConfig),
    config: input.config,
    dbAuth: Option.getOrUndefined(
      resolveOptionalSecretRef(
        {
          secretKey: input.flags.dbAuthSecretKey,
          secretName: input.flags.dbAuthSecretName,
          skip: input.flags.skipDbAuth,
        },
        Option.fromUndefinedOr(momokaya?.submit.dbAuth)
      )
    ),
    delivery: { pullRequest: input.flags.openPr === true },
    eventAuthSecretKey: momokaya?.submit.eventAuthSecretKey,
    eventAuthSecretName: momokaya?.submit.eventAuthSecretName,
    eventUrl: input.eventUrl,
    generateName: input.flags.generateName,
    gitCredentialsSecretName: momokaya?.submit.gitCredentialsSecretName,
    githubAuthSecretName: momokaya?.submit.githubAuthSecretName,
    image: input.flags.image,
    imagePullPolicy: parseImagePullPolicy(input.flags.imagePullPolicy),
    imagePullSecretName:
      input.flags.imagePullSecret ?? momokaya?.submit.imagePullSecretName,
    kubeContext: input.flags.kubeContext ?? momokaya?.kubernetes.context,
    kubeconfigPath: input.flags.kubeconfig ?? momokaya?.kubernetes.kubeconfig,
    mcpGatewayAuth: Option.getOrUndefined(
      resolveOptionalSecretRef(
        {
          secretKey: input.flags.mcpGatewayAuthSecretKey,
          secretName: input.flags.mcpGatewayAuthSecretName,
          skip: input.flags.skipMcpGatewayAuth,
        },
        Option.fromUndefinedOr(momokaya?.submit.mcpGatewayAuth)
      )
    ),
    name: input.flags.name,
    namespace: input.flags.namespace ?? momokaya?.kubernetes.namespace,
    npmRegistryAuthSecretName: Option.getOrUndefined(
      resolveOptionalSecretName(
        {
          secretName: input.flags.npmRegistryAuthSecretName,
          skip: input.flags.skipNpmRegistryAuth,
        },
        Option.fromUndefinedOr(momokaya?.submit.npmRegistryAuthSecretName)
      )
    ),
    serviceAccountName:
      input.flags.serviceAccount ?? momokaya?.submit.serviceAccountName,
    worktreePath: input.cwd,
  };
};

export const buildMokaSubmitInputFromCli = (input: {
  config: PipelineConfig;
  cwd: string;
  flags: MokaSubmitFlags;
  globalConfig?: MokaGlobalConfig;
  input: string[];
}): MokaSubmitInput => {
  const commonOptions = mokaCommonSubmitOptions({
    config: input.config,
    cwd: input.cwd,
    eventUrl: resolveMokaEventUrl(input.flags, input.globalConfig),
    flags: input.flags,
    globalConfig: input.globalConfig,
  });
  if (input.flags.command === true) {
    return submitMokaCommandInput(input.input, input.flags, commonOptions);
  }
  return submitMokaGraphInput(input.input, input.flags, commonOptions);
};

export const runMokaSubmitFromCli = async (
  input: string[],
  flags: MokaSubmitFlags
): ReturnType<typeof submitMoka> => {
  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const config = loadPipelineConfig(cwd, {
    allowMissingLintFileReferences: true,
  });
  const globalConfig = loadMokaGlobalConfig() ?? undefined;
  return await submitMoka(
    buildMokaSubmitInputFromCli({ config, cwd, flags, globalConfig, input })
  );
};
