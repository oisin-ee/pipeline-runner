import type { ArgoExecutableTask } from "../../argo-graph";
import { parseStrictWithSchema, mutableArray } from "../../schema-boundary";
import { argoWorkflowVolumeMountSchema, argoWorkflowVolumeSchema } from "./model";
import type { ArgoWorkflowVolume, ArgoWorkflowVolumeMount, ParsedBuildRunnerArgoWorkflowOptions } from "./model";
import { RUNNER_GIT_CREDENTIALS_PATH, RUNNER_WORKFLOW_PAYLOAD_PATH, RUNNER_WORKFLOW_SCHEDULE_PATH } from "./policy";

export interface RunnerWorkflowStorage {
  volumeMounts: ArgoWorkflowVolumeMount[];
  volumes: ArgoWorkflowVolume[];
}

type RunnerWorkflowSecretOptions = Pick<
  ParsedBuildRunnerArgoWorkflowOptions,
  | "eventAuthSecretKey"
  | "eventAuthSecretName"
  | "gitCredentialsSecretName"
  | "githubAuthSecretName"
  | "npmRegistryAuthSecretName"
>;

type DynamicRunnerWorkflowStorageOptions = RunnerWorkflowSecretOptions &
  Pick<ParsedBuildRunnerArgoWorkflowOptions, "payloadConfigMapKey" | "payloadConfigMapName">;

const runnerPayloadVolume = (
  options: Pick<ParsedBuildRunnerArgoWorkflowOptions, "payloadConfigMapKey" | "payloadConfigMapName">,
): ArgoWorkflowVolume => ({
  configMap: {
    items: [{ key: options.payloadConfigMapKey, path: "payload.json" }],
    name: options.payloadConfigMapName,
  },
  name: "runner-payload",
});

const runnerPayloadVolumeMount = (): ArgoWorkflowVolumeMount => ({
  mountPath: RUNNER_WORKFLOW_PAYLOAD_PATH,
  name: "runner-payload",
  readOnly: true,
  subPath: "payload.json",
});

const appendEventAuthStorage = (
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[],
): void => {
  if (options.eventAuthSecretName === undefined || options.eventAuthSecretName.length === 0) {
    return;
  }
  volumes.push({
    name: "runner-event-auth",
    secret: {
      ...(options.eventAuthSecretKey !== undefined && options.eventAuthSecretKey.length > 0
        ? {
            items: [
              {
                key: options.eventAuthSecretKey,
                path: options.eventAuthSecretKey,
              },
            ],
          }
        : {}),
      secretName: options.eventAuthSecretName,
    },
  });
  volumeMounts.push({
    mountPath: "/etc/pipeline/event-auth",
    name: "runner-event-auth",
    readOnly: true,
  });
};

const appendGitCredentialsStorage = (
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[],
): void => {
  if (options.gitCredentialsSecretName === undefined || options.gitCredentialsSecretName.length === 0) {
    return;
  }
  volumes.push({
    name: "runner-git-credentials",
    secret: {
      defaultMode: 0o400,
      secretName: options.gitCredentialsSecretName,
    },
  });
  volumeMounts.push({
    mountPath: RUNNER_GIT_CREDENTIALS_PATH,
    name: "runner-git-credentials",
    readOnly: true,
  });
};

const appendGithubAuthStorage = (
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[],
): void => {
  if (options.githubAuthSecretName === undefined || options.githubAuthSecretName.length === 0) {
    return;
  }
  volumes.push({
    name: "github-auth",
    secret: {
      items: [{ key: "hosts.yml", path: "hosts.yml" }],
      secretName: options.githubAuthSecretName,
    },
  });
  volumeMounts.push({
    mountPath: "/root/.config/gh/hosts.yml",
    name: "github-auth",
    readOnly: true,
    subPath: "hosts.yml",
  });
};

const appendNpmRegistryAuthStorage = (
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[],
): void => {
  if (options.npmRegistryAuthSecretName === undefined || options.npmRegistryAuthSecretName.length === 0) {
    return;
  }
  volumes.push({
    name: "npm-registry-auth",
    secret: {
      items: [{ key: "npmrc", path: "npmrc" }],
      secretName: options.npmRegistryAuthSecretName,
    },
  });
  volumeMounts.push({
    mountPath: "/root/.npmrc",
    name: "npm-registry-auth",
    readOnly: true,
    subPath: "npmrc",
  });
};

// Both static and dynamic runner workflows mount the same set of optional
// secret-backed volumes -- one call site, not duplicated per builder.
const appendSharedSecretStorage = (
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[],
): void => {
  appendEventAuthStorage(options, volumes, volumeMounts);
  appendGitCredentialsStorage(options, volumes, volumeMounts);
  appendGithubAuthStorage(options, volumes, volumeMounts);
  appendNpmRegistryAuthStorage(options, volumes, volumeMounts);
};

export const runnerWorkflowStorage = (
  options: ParsedBuildRunnerArgoWorkflowOptions,
  tasks: ArgoExecutableTask[],
): RunnerWorkflowStorage => {
  const volumes: ArgoWorkflowVolume[] = [
    runnerPayloadVolume(options),
    {
      configMap: {
        items: [{ key: options.scheduleConfigMapKey, path: "schedule.yaml" }],
        name: options.scheduleConfigMapName,
      },
      name: "runner-schedule",
    },
    {
      configMap: {
        items: tasks.map((task) => ({
          key: `${task.taskName}.json`,
          path: `${task.taskName}.json`,
        })),
        name: options.taskDescriptorConfigMapName,
      },
      name: "runner-task-descriptor",
    },
  ];
  const volumeMounts: ArgoWorkflowVolumeMount[] = [
    runnerPayloadVolumeMount(),
    {
      mountPath: RUNNER_WORKFLOW_SCHEDULE_PATH,
      name: "runner-schedule",
      readOnly: true,
      subPath: "schedule.yaml",
    },
  ];

  appendSharedSecretStorage(options, volumes, volumeMounts);

  return {
    volumeMounts: parseStrictWithSchema(mutableArray(argoWorkflowVolumeMountSchema), volumeMounts),
    volumes: parseStrictWithSchema(mutableArray(argoWorkflowVolumeSchema), volumes),
  };
};

export const dynamicRunnerWorkflowStorage = (options: DynamicRunnerWorkflowStorageOptions): RunnerWorkflowStorage => {
  const volumes: ArgoWorkflowVolume[] = [runnerPayloadVolume(options)];
  const volumeMounts: ArgoWorkflowVolumeMount[] = [runnerPayloadVolumeMount()];

  appendSharedSecretStorage(options, volumes, volumeMounts);

  return {
    volumeMounts: parseStrictWithSchema(mutableArray(argoWorkflowVolumeMountSchema), volumeMounts),
    volumes: parseStrictWithSchema(mutableArray(argoWorkflowVolumeSchema), volumes),
  };
};
