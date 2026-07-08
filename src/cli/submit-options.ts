import * as Option from "effect/Option";
import type { Command } from "effect/unstable/cli";
import { Argument, Flag } from "effect/unstable/cli";

import type { PipelineConfig } from "../config";
import { loadPipelineConfig } from "../config";
import { loadMokaGlobalConfig } from "../moka-global-config";
import type { MokaGlobalConfig } from "../moka-global-config";
import { submitMoka } from "../moka-submit";
import { decodeLiteralCliArgs, literalArgFlagName } from "./cli-args";

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

const imagePullPolicyChoices: readonly ["Always", "IfNotPresent", "Never"] = [
  "Always",
  "IfNotPresent",
  "Never",
];

export const mokaSubmitCliConfig = {
  command: Flag.boolean("command").pipe(
    Flag.withDescription("treat input after -- as explicit argv")
  ),
  dbAuthSecretKey: Flag.string("db-auth-secret-key").pipe(
    Flag.withDescription("override momokaya.submit.dbAuth secret key"),
    Flag.optional
  ),
  dbAuthSecretName: Flag.string("db-auth-secret-name").pipe(
    Flag.withDescription("override momokaya.submit.dbAuth secret name"),
    Flag.optional
  ),
  eventUrl: Flag.string("event-url").pipe(
    Flag.withDescription("runner event sink URL"),
    Flag.optional
  ),
  generateName: Flag.string("generate-name").pipe(
    Flag.withDescription("Workflow metadata.generateName"),
    Flag.optional
  ),
  image: Flag.string("image").pipe(
    Flag.withDescription("runner image"),
    Flag.optional
  ),
  imagePullPolicy: Flag.choice(
    "image-pull-policy",
    imagePullPolicyChoices
  ).pipe(
    Flag.withDescription("runner image pull policy"),
    Flag.withDefault(imagePullPolicyChoices[0])
  ),
  imagePullSecret: Flag.string("image-pull-secret").pipe(
    Flag.withDescription("imagePullSecret name"),
    Flag.optional
  ),
  input: Argument.string("input").pipe(
    Argument.withDescription(
      "task description, or command argv with --command"
    ),
    Argument.variadic({ min: 0 })
  ),
  kubeContext: Flag.string("kube-context").pipe(
    Flag.withDescription("kubeconfig context to target"),
    Flag.optional
  ),
  kubeconfig: Flag.string("kubeconfig").pipe(
    Flag.withDescription("kubeconfig path"),
    Flag.optional
  ),
  literalArgs: Flag.string(literalArgFlagName).pipe(
    Flag.withDescription("internal preserved command argv"),
    Flag.withHidden,
    Flag.atLeast(0)
  ),
  mcpGatewayAuthSecretKey: Flag.string("mcp-gateway-auth-secret-key").pipe(
    Flag.withDescription("override momokaya.submit.mcpGatewayAuth secret key"),
    Flag.optional
  ),
  mcpGatewayAuthSecretName: Flag.string("mcp-gateway-auth-secret-name").pipe(
    Flag.withDescription("override momokaya.submit.mcpGatewayAuth secret name"),
    Flag.optional
  ),
  name: Flag.string("name").pipe(
    Flag.withDescription("Workflow metadata.name"),
    Flag.optional
  ),
  namespace: Flag.string("namespace").pipe(
    Flag.withDescription("Workflow namespace"),
    Flag.optional
  ),
  npmRegistryAuthSecretName: Flag.string("npm-registry-auth-secret-name").pipe(
    Flag.withDescription("override momokaya.submit.npmRegistryAuthSecretName"),
    Flag.optional
  ),
  openPr: Flag.boolean("open-pr").pipe(
    Flag.withDescription(
      "append an open-pull-request delivery node (preview-labelled PR)"
    )
  ),
  quick: Flag.boolean("quick").pipe(
    Flag.withDescription("submit the compact graph")
  ),
  schedule: Flag.string("schedule").pipe(
    Flag.withDescription("approved schedule YAML to submit"),
    Flag.optional
  ),
  serviceAccount: Flag.string("service-account").pipe(
    Flag.withDescription("Workflow service account"),
    Flag.optional
  ),
  skipDbAuth: Flag.boolean("skip-db-auth").pipe(
    Flag.withDescription(
      "omit MOKA_DB_URL injection regardless of global config"
    )
  ),
  skipMcpGatewayAuth: Flag.boolean("skip-mcp-gateway-auth").pipe(
    Flag.withDescription(
      "omit PIPELINE_MCP_GATEWAY_AUTHORIZATION injection regardless of global config"
    )
  ),
  skipNpmRegistryAuth: Flag.boolean("skip-npm-registry-auth").pipe(
    Flag.withDescription(
      "omit the /root/.npmrc mount regardless of global config"
    )
  ),
  task: Flag.string("task").pipe(
    Flag.withDescription("task description for command-mode metadata"),
    Flag.optional
  ),
};

export interface ParsedMokaSubmitCliInput {
  readonly flags: MokaSubmitFlags;
  readonly input: string[];
}

export const normalizeMokaSubmitCliInput = (
  parsed: Command.Command.Config.Infer<typeof mokaSubmitCliConfig>
): ParsedMokaSubmitCliInput => {
  const literalArgs = decodeLiteralCliArgs(parsed.literalArgs);
  return {
    flags: {
      command: parsed.command,
      dbAuthSecretKey: Option.getOrUndefined(parsed.dbAuthSecretKey),
      dbAuthSecretName: Option.getOrUndefined(parsed.dbAuthSecretName),
      eventUrl: Option.getOrUndefined(parsed.eventUrl),
      generateName: Option.getOrUndefined(parsed.generateName),
      image: Option.getOrUndefined(parsed.image),
      imagePullPolicy: parsed.imagePullPolicy,
      imagePullSecret: Option.getOrUndefined(parsed.imagePullSecret),
      kubeContext: Option.getOrUndefined(parsed.kubeContext),
      kubeconfig: Option.getOrUndefined(parsed.kubeconfig),
      mcpGatewayAuthSecretKey: Option.getOrUndefined(
        parsed.mcpGatewayAuthSecretKey
      ),
      mcpGatewayAuthSecretName: Option.getOrUndefined(
        parsed.mcpGatewayAuthSecretName
      ),
      name: Option.getOrUndefined(parsed.name),
      namespace: Option.getOrUndefined(parsed.namespace),
      npmRegistryAuthSecretName: Option.getOrUndefined(
        parsed.npmRegistryAuthSecretName
      ),
      openPr: parsed.openPr,
      quick: parsed.quick,
      schedule: Option.getOrUndefined(parsed.schedule),
      serviceAccount: Option.getOrUndefined(parsed.serviceAccount),
      skipDbAuth: parsed.skipDbAuth,
      skipMcpGatewayAuth: parsed.skipMcpGatewayAuth,
      skipNpmRegistryAuth: parsed.skipNpmRegistryAuth,
      task: Option.getOrUndefined(parsed.task),
    },
    input: literalArgs.length > 0 ? literalArgs : [...parsed.input],
  };
};

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
