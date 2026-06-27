import { submitRunnerArgoWorkflow } from "../../argo-submit";
import type { PipelineConfig } from "../../config";
import type { BrokerAuthOption } from "../../credentials/broker";
import { buildRunnerCommandPayload } from "../../runner-command-contract";
import { workflowSubmitResultSchema } from "../../workflow-submit-contract";
import type { CompiledMokaSubmitPlan } from "./compilation";
import type { MokaSubmitOutput, ParsedMokaBaseOptions } from "./contract";
import { runnerEvents } from "./event-boundary";
import type { MokaSubmissionContext } from "./io";

export interface MokaWorkflowSubmitOptions {
  brokerAuth: BrokerAuthOption;
  config: PipelineConfig;
  eventAuthSecretKey?: string;
  eventAuthSecretName?: string;
  generateName?: string;
  gitCredentialsSecretName?: string;
  githubAuthSecretName?: string;
  image?: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  imagePullSecretName?: string;
  kubeconfigPath?: string;
  name?: string;
  namespace: string;
  payloadJson: string;
  scheduleYaml: string;
  serviceAccountName?: string;
}

export type MokaWorkflowSubmit = (
  options: MokaWorkflowSubmitOptions
) => Promise<MokaSubmitOutput>;

export async function submitCompiledMokaWorkflow(input: {
  context: MokaSubmissionContext;
  options: ParsedMokaBaseOptions;
  plan: CompiledMokaSubmitPlan;
  submitWorkflow?: MokaWorkflowSubmit;
}): Promise<MokaSubmitOutput> {
  const submitWorkflow = input.submitWorkflow ?? submitRunnerArgoWorkflow;
  const result = await submitWorkflow({
    ...workflowSubmitOptions(input.options),
    config: input.plan.config,
    generateName: input.plan.generateName,
    payloadJson: runnerPayloadJson({
      context: input.context,
      options: input.options,
      plan: input.plan,
    }),
    scheduleYaml: input.plan.scheduleYaml,
  });
  return workflowSubmitResultSchema.parse(result);
}

function workflowSubmitOptions(
  options: ParsedMokaBaseOptions
): Omit<MokaWorkflowSubmitOptions, "config" | "payloadJson" | "scheduleYaml"> {
  return {
    brokerAuth: options.brokerAuth,
    eventAuthSecretKey: options.eventAuthSecretKey,
    eventAuthSecretName: options.eventAuthSecretName,
    generateName: options.generateName,
    gitCredentialsSecretName: options.gitCredentialsSecretName,
    githubAuthSecretName: options.githubAuthSecretName,
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    imagePullSecretName: options.imagePullSecretName,
    kubeconfigPath: options.kubeconfigPath,
    name: options.name,
    namespace: requireSubmitOption(options.namespace, "namespace"),
    serviceAccountName: options.serviceAccountName,
  };
}

function runnerPayloadJson(input: {
  context: MokaSubmissionContext;
  options: ParsedMokaBaseOptions;
  plan: Pick<
    CompiledMokaSubmitPlan,
    "runId" | "submission" | "task" | "workflowId"
  >;
}): string {
  return JSON.stringify(
    buildRunnerCommandPayload({
      delivery: input.options.delivery,
      events: runnerEvents(input.options),
      hookPolicy: input.options.hookPolicy,
      repository: {
        baseBranch: input.context.repository.baseBranch,
        sha: input.context.repository.sha,
        url: input.context.repository.url,
      },
      run: {
        id: input.plan.runId,
        project: input.context.run.project,
        requestedBy: input.context.run.requestedBy,
      },
      submission: input.plan.submission,
      task: input.plan.task,
      workflow: { id: input.plan.workflowId },
    })
  );
}

function requireSubmitOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for moka submit`);
  }
  return value;
}
