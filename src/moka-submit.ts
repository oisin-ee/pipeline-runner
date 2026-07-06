import * as HashSet from "effect/HashSet";
import * as Schema from "effect/Schema";

import type { PipelineConfig } from "./config";
import { configWithSubmitHooks } from "./remote/submit/event-boundary";
import { MOKA_SUBMIT_HOOK_EVENTS } from "./remote/submit/hook-events";
import { runnerPodSubmitOptionShape } from "./remote/submit/options";
import { submitParsedMoka } from "./remote/submit/service";
import type { SubmitMokaDependencies } from "./remote/submit/service";
import {
  runnerDeliverySchema,
  runnerHookPolicySchema,
  runnerRepositoryContextSchema,
  runnerRunIdentitySchema,
  runnerTaskSchema,
} from "./runner-command-contract";
import {
  nonEmptyMutableArray,
  parseStrictWithSchema,
  positiveInteger,
  requiredString,
  unknownRecord,
  urlString,
  withDefault,
  struct,
} from "./schema-boundary";
import { workflowSubmitResultSchema } from "./workflow-submit-contract";

const imagePullPolicySchema = withDefault(Schema.Literals(["Always", "IfNotPresent", "Never"]), "Always");

const mokaSubmitTaskInput = Schema.Union([requiredString, runnerTaskSchema]);

const mokaSubmitEventsSchema = struct({
  authHeader: withDefault(requiredString, "Authorization"),
  authTokenFile: Schema.optional(requiredString),
  url: urlString,
});

const mokaSubmitHookWhereSchema = struct({
  gate: Schema.optional(requiredString),
  node: Schema.optional(requiredString),
  workflow: Schema.optional(requiredString),
});

const mokaSubmitHookBaseFields = {
  failure: withDefault(Schema.Literals(["fail", "ignore"]), "ignore"),
  input: Schema.optional(unknownRecord),
  publishResult: Schema.optional(Schema.Boolean),
  saveResultAs: Schema.optional(requiredString),
  timeoutMs: Schema.optional(positiveInteger),
  where: Schema.optional(mokaSubmitHookWhereSchema),
};

const mokaSubmitCommandHookSchema = struct({
  ...mokaSubmitHookBaseFields,
  command: nonEmptyMutableArray(requiredString),
  kind: Schema.Literal("command"),
  outputLimitBytes: Schema.optional(positiveInteger),
  trusted: Schema.optional(Schema.Boolean),
});

const mokaSubmitModuleHookSchema = struct({
  ...mokaSubmitHookBaseFields,
  kind: Schema.Literal("module"),
  module: requiredString,
});

const mokaSubmitDirectHook = Schema.Union([mokaSubmitCommandHookSchema, mokaSubmitModuleHookSchema]);

const directHookEventKeys = HashSet.fromIterable(MOKA_SUBMIT_HOOK_EVENTS);
const unsupportedDirectHookEventKey = Schema.String.check(
  Schema.makeFilter(
    (value) => (HashSet.has(directHookEventKeys, value) ? `Unsupported direct hook event ${value}` : true),
    {
      description: "Rejects keys that collide with supported direct hook events.",
      identifier: "UnsupportedDirectHookEventKey",
      title: "Unsupported direct hook event key",
    },
  ),
);

export const mokaSubmitDirectHooks = Schema.StructWithRest(
  struct({
    "gate.failure": Schema.optional(mokaSubmitDirectHook),
    "node.error": Schema.optional(mokaSubmitDirectHook),
    "node.finish": Schema.optional(mokaSubmitDirectHook),
    "node.start": Schema.optional(mokaSubmitDirectHook),
    "node.success": Schema.optional(mokaSubmitDirectHook),
    "workflow.complete": Schema.optional(mokaSubmitDirectHook),
    "workflow.failure": Schema.optional(mokaSubmitDirectHook),
    "workflow.start": Schema.optional(mokaSubmitDirectHook),
    "workflow.success": Schema.optional(mokaSubmitDirectHook),
  }),
  [Schema.Record(unsupportedDirectHookEventKey, Schema.Never)],
);
export type mokaSubmitDirectHooks = typeof mokaSubmitDirectHooks.Type;

export const mokaSubmitHookPolicySchema = runnerHookPolicySchema;

export const mokaSubmitResultSchema = workflowSubmitResultSchema;

const mokaSubmitBaseOptionsFields = {
  ...runnerPodSubmitOptionShape,
  delivery: withDefault(runnerDeliverySchema, {
    mode: "create-new-pr",
    pullRequest: false,
  }),
  eventSink: Schema.optional(mokaSubmitEventsSchema),
  eventUrl: Schema.optional(urlString),
  events: Schema.optional(mokaSubmitEventsSchema),
  hookPolicy: Schema.optional(mokaSubmitHookPolicySchema),
  hooks: Schema.optional(mokaSubmitDirectHooks),
  imagePullPolicy: imagePullPolicySchema,
  namespace: Schema.optional(requiredString),
  repository: Schema.optional(runnerRepositoryContextSchema),
  run: Schema.optional(runnerRunIdentitySchema),
};
const mokaSubmitBaseOptionsSchema = struct(mokaSubmitBaseOptionsFields);

const mokaGraphSubmitOptionsSchema = struct({
  ...mokaSubmitBaseOptionsFields,
  mode: Schema.Literals(["full", "quick"]),
  schedulePath: Schema.optional(requiredString),
  scheduleYaml: Schema.optional(requiredString),
  task: mokaSubmitTaskInput,
  type: Schema.Literal("graph"),
});

const mokaCommandSubmitOptionsSchema = struct({
  ...mokaSubmitBaseOptionsFields,
  commandArgv: nonEmptyMutableArray(requiredString),
  task: Schema.optional(mokaSubmitTaskInput),
  type: Schema.Literal("command"),
});

const mokaSubmitOptionsUnion = Schema.Union([mokaGraphSubmitOptionsSchema, mokaCommandSubmitOptionsSchema]);

type MokaSubmitOptionsUnion = typeof mokaSubmitOptionsUnion.Type;

const hasEventSink = (data: MokaSubmitOptionsUnion): boolean =>
  data.eventSink !== undefined || data.events !== undefined;

export const mokaSubmitOptionsSchema = mokaSubmitOptionsUnion.check(
  Schema.makeFilter(
    (data) => {
      if (data.eventSink !== undefined && data.events !== undefined) {
        return "Choose either eventSink or events, not both";
      }
      return (
        hasEventSink(data) ||
        data.eventUrl !== undefined ||
        "eventUrl is required unless eventSink or events is provided"
      );
    },
    {
      description: "Submit options must choose one event sink source.",
      identifier: "MokaSubmitOptionsEventSink",
      title: "Moka submit options event sink",
    },
  ),
);

type ImagePullPolicy = "Always" | "IfNotPresent" | "Never";
type DeliveryMode = "create-new-pr" | "update-existing-pr";
type SubmitFailureMode = "fail" | "ignore";
type GraphSubmitMode = "full" | "quick";

interface SecretRefInput {
  secretKey?: string;
  secretName: string;
}

interface BrokerAuthInput extends SecretRefInput {
  url?: string;
}

interface MokaSubmitEventsInput {
  authHeader?: string;
  authTokenFile?: string;
  url: string;
}

interface MokaSubmitHookWhereInput {
  gate?: string;
  node?: string;
  workflow?: string;
}

interface MokaSubmitHookBaseInput {
  failure?: SubmitFailureMode;
  input?: Record<string, unknown>;
  publishResult?: boolean;
  saveResultAs?: string;
  timeoutMs?: number;
  where?: MokaSubmitHookWhereInput;
}

interface MokaSubmitCommandHookInput extends MokaSubmitHookBaseInput {
  command: string[];
  kind: "command";
  outputLimitBytes?: number;
  trusted?: boolean;
}

interface MokaSubmitModuleHookInput extends MokaSubmitHookBaseInput {
  kind: "module";
  module: string;
}

type MokaSubmitDirectHookInput = MokaSubmitCommandHookInput | MokaSubmitModuleHookInput;

interface MokaSubmitBaseOptionsInput {
  activeDeadlineSeconds?: number;
  brokerAuth: BrokerAuthInput;
  dbAuth?: SecretRefInput;
  delivery?: {
    mode?: DeliveryMode;
    pullRequest?: boolean;
  };
  eventAuthSecretKey?: string;
  eventAuthSecretName?: string;
  eventSink?: MokaSubmitEventsInput;
  eventUrl?: string;
  events?: MokaSubmitEventsInput;
  generateName?: string;
  gitCredentialsSecretName?: string;
  githubAuthSecretName?: string;
  hookPolicy?: typeof mokaSubmitHookPolicySchema.Type;
  hooks?: Partial<Record<(typeof MOKA_SUBMIT_HOOK_EVENTS)[number], MokaSubmitDirectHookInput>>;
  image?: string;
  imagePullPolicy?: ImagePullPolicy;
  imagePullSecretName?: string;
  kubeContext?: string;
  kubeconfigPath?: string;
  mcpGatewayAuth?: SecretRefInput;
  name?: string;
  namespace?: string;
  npmRegistryAuthSecretName?: string;
  podGC?: typeof runnerPodSubmitOptionShape.podGC.Type;
  repository?: typeof runnerRepositoryContextSchema.Type;
  run?: typeof runnerRunIdentitySchema.Type;
  serviceAccountName?: string;
  ttlStrategy?: typeof runnerPodSubmitOptionShape.ttlStrategy.Type;
}

interface MokaGraphSubmitOptionsInput extends MokaSubmitBaseOptionsInput {
  mode: GraphSubmitMode;
  schedulePath?: string;
  scheduleYaml?: string;
  task: string | typeof runnerTaskSchema.Type;
  type: "graph";
}

interface MokaCommandSubmitOptionsInput extends MokaSubmitBaseOptionsInput {
  commandArgv: string[];
  task?: string | typeof runnerTaskSchema.Type;
  type: "command";
}

export type MokaSubmitOptionsInput = MokaCommandSubmitOptionsInput | MokaGraphSubmitOptionsInput;
export type MokaSubmitOptionsOutput = typeof mokaSubmitOptionsSchema.Type;
export type MokaSubmitDirectHooksInput = MokaSubmitBaseOptionsInput["hooks"];
export type MokaSubmitDirectHooksOutput = typeof mokaSubmitDirectHooks.Type;
export type MokaSubmitHookPolicyInput = (typeof mokaSubmitHookPolicySchema)["~type.make.in"];
export type MokaSubmitHookPolicyOutput = typeof mokaSubmitHookPolicySchema.Type;
export type MokaSubmitInput = MokaSubmitOptionsInput & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type MokaSubmitOptions = MokaSubmitInput;
export type MokaSubmitOutput = typeof mokaSubmitResultSchema.Type;
export type MokaSubmitResult = MokaSubmitOutput;

export type ParsedMokaSubmitOptions = MokaSubmitOptionsOutput & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type ParsedMokaGraphOptions = typeof mokaGraphSubmitOptionsSchema.Type & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type ParsedMokaCommandOptions = typeof mokaCommandSubmitOptionsSchema.Type & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type ParsedMokaBaseOptions = typeof mokaSubmitBaseOptionsSchema.Type;
export type ParsedMokaWithRun = ParsedMokaBaseOptions & {
  run?: typeof runnerRunIdentitySchema.Type;
};
export type MokaSubmitDirectHooks = typeof mokaSubmitDirectHooks.Type;
export type MokaSubmitDirectHook = typeof mokaSubmitDirectHook.Type;

export const submitMoka = async (
  rawOptions: MokaSubmitInput,
  dependencies: SubmitMokaDependencies = {},
): Promise<MokaSubmitOutput> => {
  const { config, worktreePath, ...schemaOptions } = rawOptions;
  const options = parseStrictWithSchema(mokaSubmitOptionsSchema, schemaOptions);
  const parsedOptions: ParsedMokaSubmitOptions = {
    ...options,
    config: configWithSubmitHooks(config, options.hooks),
    worktreePath,
  };
  return await submitParsedMoka(parsedOptions, dependencies);
};

export { mokaSubmitDirectHooks as mokaSubmitDirectHooksSchema };
