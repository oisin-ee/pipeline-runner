import { z } from "zod";
import type { PipelineConfig } from "./config";
import { brokerAuthOptionSchema } from "./credentials/broker";
import {
  dbAuthOptionSchema,
  mcpGatewayAuthOptionSchema,
} from "./remote/argo/model";
import { configWithSubmitHooks } from "./remote/submit/event-boundary";
import { MOKA_SUBMIT_HOOK_EVENTS } from "./remote/submit/hook-events";
import {
  type SubmitMokaDependencies,
  submitParsedMoka,
} from "./remote/submit/service";
import {
  runnerDeliverySchema,
  runnerHookPolicySchema,
  runnerRepositoryContextSchema,
  runnerRunIdentitySchema,
  runnerTaskSchema,
} from "./runner-command-contract";
import { workflowSubmitResultSchema } from "./workflow-submit-contract";

const imagePullPolicySchema = z
  .enum(["Always", "IfNotPresent", "Never"])
  .default("Always");

const mokaSubmitTaskInputSchema = z.union([
  z.string().min(1),
  runnerTaskSchema,
]);

const mokaSubmitEventsSchema = z
  .object({
    authHeader: z.string().min(1).default("Authorization"),
    authTokenFile: z.string().min(1).optional(),
    url: z.string().url(),
  })
  .strict();

const mokaSubmitHookWhereSchema = z
  .object({
    gate: z.string().min(1).optional(),
    node: z.string().min(1).optional(),
    workflow: z.string().min(1).optional(),
  })
  .strict();

const mokaSubmitHookBaseSchema = z
  .object({
    failure: z.enum(["fail", "ignore"]).default("ignore"),
    input: z.record(z.string(), z.unknown()).optional(),
    publishResult: z.boolean().optional(),
    saveResultAs: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    where: mokaSubmitHookWhereSchema.optional(),
  })
  .strict();

const mokaSubmitCommandHookSchema = mokaSubmitHookBaseSchema
  .extend({
    command: z.array(z.string().min(1)).min(1),
    kind: z.literal("command"),
    outputLimitBytes: z.number().int().positive().optional(),
    trusted: z.boolean().optional(),
  })
  .strict();

const mokaSubmitModuleHookSchema = mokaSubmitHookBaseSchema
  .extend({
    kind: z.literal("module"),
    module: z.string().min(1),
  })
  .strict();

const mokaSubmitDirectHookSchema = z.discriminatedUnion("kind", [
  mokaSubmitCommandHookSchema,
  mokaSubmitModuleHookSchema,
]);

export const mokaSubmitDirectHooksSchema = z.partialRecord(
  z.enum(MOKA_SUBMIT_HOOK_EVENTS),
  mokaSubmitDirectHookSchema
);

export const mokaSubmitHookPolicySchema = runnerHookPolicySchema;

export const mokaSubmitResultSchema = workflowSubmitResultSchema;

const mokaSubmitBaseOptionsSchema = z
  .object({
    brokerAuth: brokerAuthOptionSchema,
    // PIPE-94.4: optional durable-substrate secret ref threaded to runner pods
    // so MOKA_DB_URL is injected as a secretKeyRef. Shared shape (single owner in
    // remote/argo/model); a k8s submission concern, alongside brokerAuth.
    dbAuth: dbAuthOptionSchema.optional(),
    // Optional secret ref threaded to runner pods so the gateway basic-auth
    // header reaches PIPELINE_MCP_GATEWAY_AUTHORIZATION via secretKeyRef. Shared
    // shape (single owner in remote/argo/model); a k8s submission concern,
    // alongside brokerAuth/dbAuth.
    mcpGatewayAuth: mcpGatewayAuthOptionSchema.optional(),
    delivery: runnerDeliverySchema.default({
      mode: "create-new-pr",
      pullRequest: false,
    }),
    eventAuthSecretKey: z.string().min(1).optional(),
    eventAuthSecretName: z.string().min(1).optional(),
    eventSink: mokaSubmitEventsSchema.optional(),
    eventUrl: z.string().url().optional(),
    events: mokaSubmitEventsSchema.optional(),
    generateName: z.string().min(1).optional(),
    gitCredentialsSecretName: z.string().min(1).optional(),
    githubAuthSecretName: z.string().min(1).optional(),
    hookPolicy: mokaSubmitHookPolicySchema.optional(),
    hooks: mokaSubmitDirectHooksSchema.optional(),
    image: z.string().min(1).optional(),
    imagePullPolicy: imagePullPolicySchema,
    imagePullSecretName: z.string().min(1).optional(),
    kubeconfigPath: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    repository: runnerRepositoryContextSchema.optional(),
    run: runnerRunIdentitySchema.optional(),
    serviceAccountName: z.string().min(1).optional(),
  })
  .strict();

const mokaGraphSubmitOptionsSchema = mokaSubmitBaseOptionsSchema
  .extend({
    mode: z.enum(["full", "quick"]),
    schedulePath: z.string().min(1).optional(),
    scheduleYaml: z.string().min(1).optional(),
    task: mokaSubmitTaskInputSchema,
    type: z.literal("graph"),
  })
  .strict();

const mokaCommandSubmitOptionsSchema = mokaSubmitBaseOptionsSchema
  .extend({
    commandArgv: z.array(z.string().min(1)).min(1),
    task: mokaSubmitTaskInputSchema.optional(),
    type: z.literal("command"),
  })
  .strict();

const mokaSubmitOptionsUnionSchema = z.discriminatedUnion("type", [
  mokaGraphSubmitOptionsSchema,
  mokaCommandSubmitOptionsSchema,
]);

type MokaSubmitOptionsUnion = z.output<typeof mokaSubmitOptionsUnionSchema>;
type MokaSubmitOptionsValidation = (
  data: MokaSubmitOptionsUnion,
  ctx: z.RefinementCtx
) => void;

const mokaSubmitOptionsValidations: MokaSubmitOptionsValidation[] = [
  (data, ctx) => {
    if (data.eventSink !== undefined && data.events !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Choose either eventSink or events, not both",
        path: ["eventSink"],
      });
    }
  },
  (data, ctx) => {
    if (
      data.eventSink === undefined &&
      data.events === undefined &&
      data.eventUrl === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "eventUrl is required unless eventSink or events is provided",
        path: ["eventUrl"],
      });
    }
  },
];

export const mokaSubmitOptionsSchema = mokaSubmitOptionsUnionSchema.superRefine(
  (data, ctx) => {
    for (const validate of mokaSubmitOptionsValidations) {
      validate(data, ctx);
    }
  }
);

export type MokaSubmitOptionsInput = z.input<typeof mokaSubmitOptionsSchema>;
export type MokaSubmitOptionsOutput = z.output<typeof mokaSubmitOptionsSchema>;
export type MokaSubmitDirectHooksInput = z.input<
  typeof mokaSubmitDirectHooksSchema
>;
export type MokaSubmitDirectHooksOutput = z.output<
  typeof mokaSubmitDirectHooksSchema
>;
export type MokaSubmitHookPolicyInput = z.input<
  typeof mokaSubmitHookPolicySchema
>;
export type MokaSubmitHookPolicyOutput = z.output<
  typeof mokaSubmitHookPolicySchema
>;
export type MokaSubmitInput = MokaSubmitOptionsInput & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type MokaSubmitOptions = MokaSubmitInput;
export type MokaSubmitOutput = z.output<typeof mokaSubmitResultSchema>;
export type MokaSubmitResult = MokaSubmitOutput;

export type ParsedMokaSubmitOptions = MokaSubmitOptionsOutput & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type ParsedMokaGraphOptions = z.output<
  typeof mokaGraphSubmitOptionsSchema
> & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type ParsedMokaCommandOptions = z.output<
  typeof mokaCommandSubmitOptionsSchema
> & {
  config: PipelineConfig;
  worktreePath?: string;
};
export type ParsedMokaBaseOptions = z.output<
  typeof mokaSubmitBaseOptionsSchema
>;
export type ParsedMokaWithRun = ParsedMokaBaseOptions & {
  run?: z.output<typeof runnerRunIdentitySchema>;
};
export type MokaSubmitDirectHooks = z.output<
  typeof mokaSubmitDirectHooksSchema
>;
export type MokaSubmitDirectHook = z.output<typeof mokaSubmitDirectHookSchema>;

export function submitMoka(
  rawOptions: MokaSubmitInput,
  dependencies: SubmitMokaDependencies = {}
): Promise<MokaSubmitOutput> {
  const { config, worktreePath, ...schemaOptions } = rawOptions;
  const options = mokaSubmitOptionsSchema.parse(schemaOptions);
  const parsedOptions: ParsedMokaSubmitOptions = {
    ...options,
    config: configWithSubmitHooks(config, options.hooks),
    worktreePath,
  };
  return submitParsedMoka(parsedOptions, dependencies);
}
