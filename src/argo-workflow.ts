import { stringify } from "yaml";
import type { z } from "zod";
import {
  type ArgoExecutableTask,
  compileArgoExecutionGraph,
} from "./argo-graph";
import type { WorkflowExecutionPlan } from "./planning/compile";
import {
  type ArgoWorkflowTemplate,
  buildDynamicRunnerArgoWorkflowOptionsSchema,
  buildRunnerArgoWorkflowOptionsSchema,
  createRunnerArgoWorkflowManifestSchema,
  type ParsedBuildDynamicRunnerArgoWorkflowOptions,
  type ParsedBuildRunnerArgoWorkflowOptions,
} from "./remote/argo/model";
import {
  RUNNER_WORKFLOW_ENTRYPOINT,
  RUNNER_WORKFLOW_START_TASK,
} from "./remote/argo/policy";
import {
  dynamicRunnerWorkflowStorage,
  type RunnerWorkflowStorage,
  runnerWorkflowStorage,
} from "./remote/argo/storage";
import {
  dynamicPreScheduleTemplate,
  dynamicReadyWaveSelectorTemplate,
  dynamicRunnerCommandTemplate,
  dynamicRunnerFinalizerTemplate,
  READY_NODE_IDS_PARAMETER,
  runnerCommandTemplate,
  runnerFinalizerTemplate,
  runnerLifecycleTemplate,
} from "./remote/argo/templates";

export const runnerArgoWorkflowManifestSchema =
  createRunnerArgoWorkflowManifestSchema();
export type ArgoWorkflowManifest = z.infer<
  typeof runnerArgoWorkflowManifestSchema
>;
export type BuildRunnerArgoWorkflowOptions = z.input<
  typeof buildRunnerArgoWorkflowOptionsSchema
> & {
  plan: WorkflowExecutionPlan;
};
export type BuildDynamicRunnerArgoWorkflowOptions = z.input<
  typeof buildDynamicRunnerArgoWorkflowOptionsSchema
>;
type ArgoWorkflowMetadata = ArgoWorkflowManifest["metadata"];
type ArgoWorkflowSpec = ArgoWorkflowManifest["spec"];

export function buildRunnerArgoWorkflowManifest(
  rawOptions: BuildRunnerArgoWorkflowOptions
): ArgoWorkflowManifest {
  const options = parsedBuildOptions(rawOptions);
  const graph = compileArgoExecutionGraph(options.plan);
  const storage = runnerWorkflowStorage(options, graph.tasks);
  return runnerArgoWorkflowManifestSchema.parse({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Workflow",
    metadata: workflowMetadata(options),
    spec: workflowSpec(options, graph.tasks, storage),
  });
}

export function buildDynamicRunnerArgoWorkflowManifest(
  rawOptions: BuildDynamicRunnerArgoWorkflowOptions
): ArgoWorkflowManifest {
  const options = buildDynamicRunnerArgoWorkflowOptionsSchema.parse(rawOptions);
  const storage = dynamicRunnerWorkflowStorage(options);
  return runnerArgoWorkflowManifestSchema.parse({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Workflow",
    metadata: dynamicWorkflowMetadata(options),
    spec: dynamicWorkflowSpec(options, storage),
  });
}

export function stringifyRunnerArgoWorkflow(
  workflow: ArgoWorkflowManifest
): string {
  return stringify(runnerArgoWorkflowManifestSchema.parse(workflow));
}

function parsedBuildOptions(
  rawOptions: BuildRunnerArgoWorkflowOptions
): ParsedBuildRunnerArgoWorkflowOptions {
  const { plan, ...schemaOptions } = rawOptions;
  return {
    ...buildRunnerArgoWorkflowOptionsSchema.parse(schemaOptions),
    plan,
  };
}

function workflowMetadata(
  options: ParsedBuildRunnerArgoWorkflowOptions
): ArgoWorkflowMetadata {
  return {
    annotations: compactRecord(options.annotations),
    ...(options.name ? { name: options.name } : {}),
    ...(options.generateName ? { generateName: options.generateName } : {}),
    labels: compactRecord({
      "pipeline.oisin.dev/source": "argo-workflow",
      "pipeline.oisin.dev/workflow": options.plan.workflowId,
      ...options.labels,
    }),
    namespace: options.namespace,
  };
}

function dynamicWorkflowMetadata(
  options: ParsedBuildDynamicRunnerArgoWorkflowOptions
): ArgoWorkflowMetadata {
  return {
    annotations: compactRecord(options.annotations),
    ...(options.name ? { name: options.name } : {}),
    ...(options.generateName ? { generateName: options.generateName } : {}),
    labels: compactRecord({
      "pipeline.oisin.dev/source": "argo-workflow",
      "pipeline.oisin.dev/workflow": options.workflowId,
      ...options.labels,
    }),
    namespace: options.namespace,
  };
}

function workflowSpec(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  tasks: ArgoExecutableTask[],
  storage: RunnerWorkflowStorage
): ArgoWorkflowSpec {
  return {
    ...(options.activeDeadlineSeconds
      ? { activeDeadlineSeconds: options.activeDeadlineSeconds }
      : {}),
    entrypoint: RUNNER_WORKFLOW_ENTRYPOINT,
    ...(options.imagePullSecretName
      ? { imagePullSecrets: [{ name: options.imagePullSecretName }] }
      : {}),
    serviceAccountName: options.serviceAccountName,
    onExit: "pipeline-finalizer",
    templates: workflowTemplates(options, tasks, storage.volumeMounts),
    ...(options.ttlStrategy ? { ttlStrategy: options.ttlStrategy } : {}),
    volumes: storage.volumes,
  };
}

function dynamicWorkflowSpec(
  options: ParsedBuildDynamicRunnerArgoWorkflowOptions,
  storage: RunnerWorkflowStorage
): ArgoWorkflowSpec {
  return {
    ...(options.activeDeadlineSeconds
      ? { activeDeadlineSeconds: options.activeDeadlineSeconds }
      : {}),
    entrypoint: RUNNER_WORKFLOW_ENTRYPOINT,
    ...(options.imagePullSecretName
      ? { imagePullSecrets: [{ name: options.imagePullSecretName }] }
      : {}),
    serviceAccountName: options.serviceAccountName,
    onExit: "pipeline-finalizer",
    templates: dynamicWorkflowTemplates(options, storage.volumeMounts),
    ...(options.ttlStrategy ? { ttlStrategy: options.ttlStrategy } : {}),
    volumes: storage.volumes,
  };
}

function workflowTemplates(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  tasks: ArgoExecutableTask[],
  volumeMounts: RunnerWorkflowStorage["volumeMounts"]
): ArgoWorkflowTemplate[] {
  return [
    workflowDagTemplate(tasks),
    runnerLifecycleTemplate(options, volumeMounts),
    ...tasks.map((task) => runnerCommandTemplate(task, options, volumeMounts)),
    runnerFinalizerTemplate(options, volumeMounts),
  ];
}

function dynamicWorkflowTemplates(
  options: ParsedBuildDynamicRunnerArgoWorkflowOptions,
  volumeMounts: RunnerWorkflowStorage["volumeMounts"]
): ArgoWorkflowTemplate[] {
  return [
    dynamicWorkflowEntrypointTemplate(),
    dynamicDrainTemplate(),
    dynamicPreScheduleTemplate("pre-research", options, volumeMounts),
    dynamicPreScheduleTemplate("pre-planning", options, volumeMounts),
    dynamicPreScheduleTemplate("generate-schedule", options, volumeMounts),
    dynamicReadyWaveSelectorTemplate(options, volumeMounts),
    dynamicRunnerCommandTemplate(options, volumeMounts),
    dynamicRunnerFinalizerTemplate(options, volumeMounts),
  ];
}

function workflowDagTemplate(
  tasks: ArgoExecutableTask[]
): ArgoWorkflowTemplate {
  return {
    dag: {
      tasks: [
        {
          name: RUNNER_WORKFLOW_START_TASK,
          template: RUNNER_WORKFLOW_START_TASK,
        },
        ...tasks.map((task) => ({
          dependencies: [RUNNER_WORKFLOW_START_TASK, ...task.dependencies],
          name: task.taskName,
          template: task.templateName,
        })),
      ],
    },
    name: RUNNER_WORKFLOW_ENTRYPOINT,
  };
}

function dynamicWorkflowEntrypointTemplate(): ArgoWorkflowTemplate {
  return {
    name: RUNNER_WORKFLOW_ENTRYPOINT,
    steps: [
      [{ name: "pre-research", template: "pre-research" }],
      [{ name: "pre-planning", template: "pre-planning" }],
      [{ name: "generate-schedule", template: "generate-schedule" }],
      [{ name: "drain-ready-waves", template: "drain-ready-waves" }],
    ],
  };
}

function dynamicDrainTemplate(): ArgoWorkflowTemplate {
  const readyExpression = `{{steps.select-ready-wave.outputs.parameters.${READY_NODE_IDS_PARAMETER}}} != []`;
  return {
    name: "drain-ready-waves",
    steps: [
      [{ name: "select-ready-wave", template: "select-ready-wave" }],
      [
        {
          arguments: {
            parameters: [{ name: "node-id", value: "{{item}}" }],
          },
          name: "run-ready-node",
          template: "runner-command",
          when: readyExpression,
          withParam: `{{steps.select-ready-wave.outputs.parameters.${READY_NODE_IDS_PARAMETER}}}`,
        },
      ],
      [
        {
          name: "drain-next-wave",
          template: "drain-ready-waves",
          when: readyExpression,
        },
      ],
    ],
  };
}

function compactRecord(
  input: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}
