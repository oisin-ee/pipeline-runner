import type { ArgoExecutableTask } from "../../argo-graph";
import { DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH } from "../../runner-command/task-descriptor";
import type {
  ArgoWorkflowTemplate,
  ArgoWorkflowVolumeMount,
  ParsedBuildRunnerArgoWorkflowOptions,
} from "./model";
import type { RunnerContainerPolicyOptions } from "./policy";
import {
  RUNNER_WORKFLOW_PAYLOAD_PATH,
  RUNNER_WORKFLOW_SCHEDULE_PATH,
  RUNNER_WORKFLOW_START_TASK,
  runnerContainerEnv,
  runnerRetryStrategy,
  runnerTemplateDeadlineSeconds,
  runnerTemplateResources,
} from "./policy";

const READY_NODE_IDS_PATH = "/tmp/moka-ready-node-ids.json";
export const READY_NODE_IDS_PARAMETER = "ready-node-ids";

type RunnerTemplateOptions = RunnerContainerPolicyOptions &
  Pick<
    ParsedBuildRunnerArgoWorkflowOptions,
    "image" | "imagePullPolicy" | "resources"
  >;

export const runnerLifecycleTemplate = (
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate => ({
  activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  container: {
    args: [
      "runner-lifecycle",
      "--phase",
      "workflow.start",
      "--payload-file",
      RUNNER_WORKFLOW_PAYLOAD_PATH,
      "--schedule-file",
      RUNNER_WORKFLOW_SCHEDULE_PATH,
    ],
    env: runnerContainerEnv(options),
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: "runner",
    resources: runnerTemplateResources(options),
    volumeMounts,
  },
  name: RUNNER_WORKFLOW_START_TASK,
  retryStrategy: runnerRetryStrategy(),
});

export const dynamicPreScheduleTemplate = (
  phase: "generate-schedule" | "pre-planning" | "pre-research",
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate => ({
  activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  container: {
    args: [
      "runner-pre-schedule",
      "--phase",
      phase,
      "--payload-file",
      RUNNER_WORKFLOW_PAYLOAD_PATH,
    ],
    env: runnerContainerEnv(options),
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: "runner",
    resources: runnerTemplateResources(options),
    volumeMounts,
  },
  name: phase,
  retryStrategy: runnerRetryStrategy(),
});

export const dynamicReadyWaveSelectorTemplate = (
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate => ({
  activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  container: {
    args: [
      "runner-select-ready-wave",
      "--payload-file",
      RUNNER_WORKFLOW_PAYLOAD_PATH,
      "--output-file",
      READY_NODE_IDS_PATH,
    ],
    env: runnerContainerEnv(options),
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: "runner",
    resources: runnerTemplateResources(options),
    volumeMounts,
  },
  name: "select-ready-wave",
  outputs: {
    parameters: [
      {
        name: READY_NODE_IDS_PARAMETER,
        valueFrom: { path: READY_NODE_IDS_PATH },
      },
    ],
  },
  retryStrategy: runnerRetryStrategy(),
});

export const dynamicRunnerCommandTemplate = (
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate => ({
  activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  container: {
    args: [
      "runner-command",
      "--payload-file",
      RUNNER_WORKFLOW_PAYLOAD_PATH,
      "--schedule-source",
      "db",
      "--node-id",
      "{{inputs.parameters.node-id}}",
    ],
    env: runnerContainerEnv(options),
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: "runner",
    resources: runnerTemplateResources(options),
    volumeMounts,
  },
  inputs: {
    parameters: [{ name: "node-id" }],
  },
  name: "runner-command",
  retryStrategy: runnerRetryStrategy(),
});

export const runnerCommandTemplate = (
  task: ArgoExecutableTask,
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate => ({
  activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  container: {
    args: [
      "runner-command",
      "--payload-file",
      RUNNER_WORKFLOW_PAYLOAD_PATH,
      "--schedule-file",
      RUNNER_WORKFLOW_SCHEDULE_PATH,
    ],
    env: runnerContainerEnv(options),
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: "runner",
    resources: runnerTemplateResources(options),
    volumeMounts: [
      ...volumeMounts,
      {
        mountPath: DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH,
        name: "runner-task-descriptor",
        readOnly: true,
        subPath: `${task.taskName}.json`,
      },
    ],
  },
  name: task.templateName,
  retryStrategy: runnerRetryStrategy(),
});

export const dynamicRunnerFinalizerTemplate = (
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate => ({
  activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  container: {
    args: [
      "runner-finalize",
      "--payload-file",
      RUNNER_WORKFLOW_PAYLOAD_PATH,
      "--schedule-source",
      "db",
      "--argo-status",
      "{{workflow.status}}",
      "--argo-failures",
      "{{workflow.failures}}",
    ],
    env: runnerContainerEnv(options),
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: "runner",
    resources: runnerTemplateResources(options),
    volumeMounts,
  },
  name: "pipeline-finalizer",
});

export const runnerFinalizerTemplate = (
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate => ({
  activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  container: {
    args: [
      "runner-finalize",
      "--payload-file",
      RUNNER_WORKFLOW_PAYLOAD_PATH,
      "--schedule-file",
      RUNNER_WORKFLOW_SCHEDULE_PATH,
      "--argo-status",
      "{{workflow.status}}",
      "--argo-failures",
      "{{workflow.failures}}",
    ],
    env: runnerContainerEnv(options),
    image: options.image,
    imagePullPolicy: options.imagePullPolicy,
    name: "runner",
    resources: runnerTemplateResources(options),
    volumeMounts,
  },
  name: "pipeline-finalizer",
});
