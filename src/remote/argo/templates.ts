import type { ArgoExecutableTask } from "../../argo-graph";
import { DEFAULT_RUNNER_TASK_DESCRIPTOR_PATH } from "../../runner-command/task-descriptor";
import type {
  ArgoWorkflowTemplate,
  ArgoWorkflowVolumeMount,
  ParsedBuildRunnerArgoWorkflowOptions,
} from "./model";
import {
  RUNNER_WORKFLOW_PAYLOAD_PATH,
  RUNNER_WORKFLOW_SCHEDULE_PATH,
  RUNNER_WORKFLOW_START_TASK,
  type RunnerContainerPolicyOptions,
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

export function runnerLifecycleTemplate(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate {
  return {
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
      command: ["moka"],
      env: runnerContainerEnv(options),
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      resources: runnerTemplateResources(options),
      volumeMounts,
    },
    name: RUNNER_WORKFLOW_START_TASK,
    retryStrategy: runnerRetryStrategy(),
    activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  };
}

export function dynamicPreScheduleTemplate(
  phase: "generate-schedule" | "pre-planning" | "pre-research",
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate {
  return {
    container: {
      args: [
        "runner-pre-schedule",
        "--phase",
        phase,
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
      ],
      command: ["moka"],
      env: runnerContainerEnv(options),
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      resources: runnerTemplateResources(options),
      volumeMounts,
    },
    name: phase,
    retryStrategy: runnerRetryStrategy(),
    activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  };
}

export function dynamicReadyWaveSelectorTemplate(
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate {
  return {
    container: {
      args: [
        "runner-select-ready-wave",
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
        "--output-file",
        READY_NODE_IDS_PATH,
      ],
      command: ["moka"],
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
    activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  };
}

export function dynamicRunnerCommandTemplate(
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate {
  return {
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
      command: ["moka"],
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
    activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  };
}

export function runnerCommandTemplate(
  task: ArgoExecutableTask,
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate {
  return {
    container: {
      args: [
        "runner-command",
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
        "--schedule-file",
        RUNNER_WORKFLOW_SCHEDULE_PATH,
      ],
      command: ["moka"],
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
    activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  };
}

export function dynamicRunnerFinalizerTemplate(
  options: RunnerTemplateOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate {
  return {
    container: {
      args: [
        "runner-finalize",
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
        "--schedule-source",
        "db",
        "--argo-status",
        "{{workflow.status}}",
      ],
      command: ["moka"],
      env: runnerContainerEnv(options),
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      resources: runnerTemplateResources(options),
      volumeMounts,
    },
    name: "pipeline-finalizer",
    activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  };
}

export function runnerFinalizerTemplate(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  volumeMounts: ArgoWorkflowVolumeMount[]
): ArgoWorkflowTemplate {
  return {
    container: {
      args: [
        "runner-finalize",
        "--payload-file",
        RUNNER_WORKFLOW_PAYLOAD_PATH,
        "--schedule-file",
        RUNNER_WORKFLOW_SCHEDULE_PATH,
        "--argo-status",
        "{{workflow.status}}",
      ],
      command: ["moka"],
      env: runnerContainerEnv(options),
      image: options.image,
      imagePullPolicy: options.imagePullPolicy,
      name: "runner",
      resources: runnerTemplateResources(options),
      volumeMounts,
    },
    name: "pipeline-finalizer",
    activeDeadlineSeconds: runnerTemplateDeadlineSeconds(),
  };
}
