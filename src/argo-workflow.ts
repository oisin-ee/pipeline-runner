import { stringify } from "yaml";
import type { z } from "zod";

import { compileArgoExecutionGraph } from "./argo-graph";
import type { ArgoExecutableTask } from "./argo-graph";
import type { WorkflowExecutionPlan } from "./planning/compile";
import {
  buildDynamicRunnerArgoWorkflowOptionsSchema,
  buildRunnerArgoWorkflowOptionsSchema,
  createRunnerArgoWorkflowManifestSchema,
} from "./remote/argo/model";
import type {
  ArgoWorkflowTemplate,
  ParsedBuildDynamicRunnerArgoWorkflowOptions,
  ParsedBuildRunnerArgoWorkflowOptions,
} from "./remote/argo/model";
import {
  RUNNER_WORKFLOW_ENTRYPOINT,
  RUNNER_WORKFLOW_START_TASK,
} from "./remote/argo/policy";
import {
  dynamicRunnerWorkflowStorage,
  runnerWorkflowStorage,
} from "./remote/argo/storage";
import type { RunnerWorkflowStorage } from "./remote/argo/storage";
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
type WorkflowSpecOptions = Pick<
  ParsedBuildRunnerArgoWorkflowOptions,
  | "activeDeadlineSeconds"
  | "imagePullSecretName"
  | "serviceAccountName"
  | "ttlStrategy"
>;
type WorkflowMetadataOptions = Pick<
  ParsedBuildRunnerArgoWorkflowOptions,
  "annotations" | "generateName" | "labels" | "name" | "namespace"
>;

export const stringifyRunnerArgoWorkflow = (
  workflow: ArgoWorkflowManifest
): string => stringify(runnerArgoWorkflowManifestSchema.parse(workflow));

const parsedBuildOptions = (
  rawOptions: BuildRunnerArgoWorkflowOptions
): ParsedBuildRunnerArgoWorkflowOptions => {
  const { plan, ...schemaOptions } = rawOptions;
  return {
    ...buildRunnerArgoWorkflowOptionsSchema.parse(schemaOptions),
    plan,
  };
};

const workflowDagTemplate = (
  tasks: ArgoExecutableTask[]
): ArgoWorkflowTemplate => ({
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
});

const workflowTemplates = (
  options: ParsedBuildRunnerArgoWorkflowOptions,
  tasks: ArgoExecutableTask[],
  volumeMounts: RunnerWorkflowStorage["volumeMounts"]
): ArgoWorkflowTemplate[] => [
  workflowDagTemplate(tasks),
  runnerLifecycleTemplate(options, volumeMounts),
  ...tasks.map((task) => runnerCommandTemplate(task, options, volumeMounts)),
  runnerFinalizerTemplate(options, volumeMounts),
];

const workflowSpecBase = (
  options: WorkflowSpecOptions,
  storage: RunnerWorkflowStorage,
  templates: ArgoWorkflowTemplate[]
): ArgoWorkflowSpec => ({
  ...(options.activeDeadlineSeconds === undefined
    ? {}
    : { activeDeadlineSeconds: options.activeDeadlineSeconds }),
  entrypoint: RUNNER_WORKFLOW_ENTRYPOINT,
  ...(options.imagePullSecretName !== undefined &&
  options.imagePullSecretName.length > 0
    ? { imagePullSecrets: [{ name: options.imagePullSecretName }] }
    : {}),
  onExit: "pipeline-finalizer",
  serviceAccountName: options.serviceAccountName,
  templates,
  ...(options.ttlStrategy ? { ttlStrategy: options.ttlStrategy } : {}),
  volumes: storage.volumes,
});

const workflowSpec = (
  options: ParsedBuildRunnerArgoWorkflowOptions,
  tasks: ArgoExecutableTask[],
  storage: RunnerWorkflowStorage
): ArgoWorkflowSpec =>
  workflowSpecBase(
    options,
    storage,
    workflowTemplates(options, tasks, storage.volumeMounts)
  );

const dynamicWorkflowEntrypointTemplate = (): ArgoWorkflowTemplate => ({
  name: RUNNER_WORKFLOW_ENTRYPOINT,
  steps: [
    [{ name: "pre-research", template: "pre-research" }],
    [{ name: "pre-planning", template: "pre-planning" }],
    [{ name: "generate-schedule", template: "generate-schedule" }],
    [{ name: "drain-ready-waves", template: "drain-ready-waves" }],
  ],
});

const dynamicDrainTemplate = (): ArgoWorkflowTemplate => {
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
};

const dynamicWorkflowTemplates = (
  options: ParsedBuildDynamicRunnerArgoWorkflowOptions,
  volumeMounts: RunnerWorkflowStorage["volumeMounts"]
): ArgoWorkflowTemplate[] => [
  dynamicWorkflowEntrypointTemplate(),
  dynamicDrainTemplate(),
  dynamicPreScheduleTemplate("pre-research", options, volumeMounts),
  dynamicPreScheduleTemplate("pre-planning", options, volumeMounts),
  dynamicPreScheduleTemplate("generate-schedule", options, volumeMounts),
  dynamicReadyWaveSelectorTemplate(options, volumeMounts),
  dynamicRunnerCommandTemplate(options, volumeMounts),
  dynamicRunnerFinalizerTemplate(options, volumeMounts),
];

const dynamicWorkflowSpec = (
  options: ParsedBuildDynamicRunnerArgoWorkflowOptions,
  storage: RunnerWorkflowStorage
): ArgoWorkflowSpec =>
  workflowSpecBase(
    options,
    storage,
    dynamicWorkflowTemplates(options, storage.volumeMounts)
  );

const compactRecord = (
  input: Partial<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(input).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );

const workflowMetadata = (
  options: WorkflowMetadataOptions,
  workflowId: string
): ArgoWorkflowMetadata => ({
  annotations: compactRecord(options.annotations),
  ...(options.name !== undefined && options.name.length > 0
    ? { name: options.name }
    : {}),
  ...(options.generateName !== undefined && options.generateName.length > 0
    ? { generateName: options.generateName }
    : {}),
  labels: compactRecord({
    "pipeline.oisin.dev/source": "argo-workflow",
    "pipeline.oisin.dev/workflow": workflowId,
    ...options.labels,
  }),
  namespace: options.namespace,
});

const runnerArgoWorkflowManifest = (
  options: WorkflowMetadataOptions,
  workflowId: string,
  spec: ArgoWorkflowSpec
): ArgoWorkflowManifest =>
  runnerArgoWorkflowManifestSchema.parse({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Workflow",
    metadata: workflowMetadata(options, workflowId),
    spec,
  });

export const buildRunnerArgoWorkflowManifest = (
  rawOptions: BuildRunnerArgoWorkflowOptions
): ArgoWorkflowManifest => {
  const options = parsedBuildOptions(rawOptions);
  const graph = compileArgoExecutionGraph(options.plan);
  const storage = runnerWorkflowStorage(options, graph.tasks);
  return runnerArgoWorkflowManifest(
    options,
    options.plan.workflowId,
    workflowSpec(options, graph.tasks, storage)
  );
};

export const buildDynamicRunnerArgoWorkflowManifest = (
  rawOptions: BuildDynamicRunnerArgoWorkflowOptions
): ArgoWorkflowManifest => {
  const options = buildDynamicRunnerArgoWorkflowOptionsSchema.parse(rawOptions);
  const storage = dynamicRunnerWorkflowStorage(options);
  return runnerArgoWorkflowManifest(
    options,
    options.workflowId,
    dynamicWorkflowSpec(options, storage)
  );
};
