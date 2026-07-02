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

type SecretRef = { secretKey?: string; secretName: string } | undefined;

// Same override precedence as kubeContext/kubeconfigPath: CLI flag wins, then
// global config, then absent. dbAuth/mcpGatewayAuth were previously read
// unconditionally from global config with no per-invocation override, which
// breaks the moment you target a cluster that doesn't have that secret name.
function resolveOptionalSecretRef(
  flags: SecretRefFlags,
  fromGlobalConfig: SecretRef
): SecretRef {
  if (flags.skip) {
    return;
  }
  if (flags.secretName) {
    return {
      secretName: flags.secretName,
      ...(flags.secretKey ? { secretKey: flags.secretKey } : {}),
    };
  }
  return fromGlobalConfig;
}

interface SecretNameFlags {
  secretName?: string;
  skip?: boolean;
}

// Same override precedence as resolveOptionalSecretRef, for a plain secret-name
// field with no separate key -- the mounted key is fixed (see
// appendNpmRegistryAuthStorage), so there is nothing for a "secret key" flag to
// override.
function resolveOptionalSecretName(
  flags: SecretNameFlags,
  fromGlobalConfig: string | undefined
): string | undefined {
  if (flags.skip) {
    return;
  }
  return flags.secretName ?? fromGlobalConfig;
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
    brokerAuth: resolveMokaBrokerAuth(input.globalConfig),
    config: input.config,
    dbAuth: resolveOptionalSecretRef(
      {
        secretKey: input.flags.dbAuthSecretKey,
        secretName: input.flags.dbAuthSecretName,
        skip: input.flags.skipDbAuth,
      },
      momokaya?.submit.dbAuth
    ),
    mcpGatewayAuth: resolveOptionalSecretRef(
      {
        secretKey: input.flags.mcpGatewayAuthSecretKey,
        secretName: input.flags.mcpGatewayAuthSecretName,
        skip: input.flags.skipMcpGatewayAuth,
      },
      momokaya?.submit.mcpGatewayAuth
    ),
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
    kubeContext: input.flags.kubeContext ?? momokaya?.kubernetes.context,
    kubeconfigPath: input.flags.kubeconfig ?? momokaya?.kubernetes.kubeconfig,
    name: input.flags.name,
    namespace: input.flags.namespace ?? momokaya?.kubernetes.namespace,
    npmRegistryAuthSecretName: resolveOptionalSecretName(
      {
        secretName: input.flags.npmRegistryAuthSecretName,
        skip: input.flags.skipNpmRegistryAuth,
      },
      momokaya?.submit.npmRegistryAuthSecretName
    ),
    serviceAccountName:
      input.flags.serviceAccount ?? momokaya?.submit.serviceAccountName,
    worktreePath: input.cwd,
  };
}

function resolveMokaBrokerAuth(
  globalConfig: MokaGlobalConfig | null | undefined
): MokaSubmitCommonOptions["brokerAuth"] {
  const brokerAuth = globalConfig?.momokaya.submit.brokerAuth;
  if (!brokerAuth) {
    throw new Error("momokaya.submit.brokerAuth is required for remote submit");
  }
  return brokerAuth;
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
    command
      .option("--kubeconfig <path>", "kubeconfig path")
      .option("--kube-context <name>", "kubeconfig context to target");
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
