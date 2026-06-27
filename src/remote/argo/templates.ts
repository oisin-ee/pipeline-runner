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
  runnerContainerEnv,
  runnerRetryStrategy,
  runnerTemplateDeadlineSeconds,
  runnerTemplateResources,
} from "./policy";

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
