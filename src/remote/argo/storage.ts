import { z } from "zod";
import type { ArgoExecutableTask } from "../../argo-graph";
import {
  type ArgoWorkflowVolume,
  type ArgoWorkflowVolumeMount,
  argoWorkflowVolumeMountSchema,
  argoWorkflowVolumeSchema,
  type ParsedBuildRunnerArgoWorkflowOptions,
} from "./model";
import {
  RUNNER_GIT_CREDENTIALS_PATH,
  RUNNER_WORKFLOW_PAYLOAD_PATH,
  RUNNER_WORKFLOW_SCHEDULE_PATH,
} from "./policy";

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
  Pick<
    ParsedBuildRunnerArgoWorkflowOptions,
    "payloadConfigMapKey" | "payloadConfigMapName"
  >;

export function runnerWorkflowStorage(
  options: ParsedBuildRunnerArgoWorkflowOptions,
  tasks: ArgoExecutableTask[]
): RunnerWorkflowStorage {
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
    volumeMounts: z.array(argoWorkflowVolumeMountSchema).parse(volumeMounts),
    volumes: z.array(argoWorkflowVolumeSchema).parse(volumes),
  };
}

export function dynamicRunnerWorkflowStorage(
  options: DynamicRunnerWorkflowStorageOptions
): RunnerWorkflowStorage {
  const volumes: ArgoWorkflowVolume[] = [runnerPayloadVolume(options)];
  const volumeMounts: ArgoWorkflowVolumeMount[] = [runnerPayloadVolumeMount()];

  appendSharedSecretStorage(options, volumes, volumeMounts);

  return {
    volumeMounts: z.array(argoWorkflowVolumeMountSchema).parse(volumeMounts),
    volumes: z.array(argoWorkflowVolumeSchema).parse(volumes),
  };
}

// Both static and dynamic runner workflows mount the same set of optional
// secret-backed volumes -- one call site, not duplicated per builder.
function appendSharedSecretStorage(
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[]
): void {
  appendEventAuthStorage(options, volumes, volumeMounts);
  appendGitCredentialsStorage(options, volumes, volumeMounts);
  appendGithubAuthStorage(options, volumes, volumeMounts);
  appendNpmRegistryAuthStorage(options, volumes, volumeMounts);
}

function runnerPayloadVolume(
  options: Pick<
    ParsedBuildRunnerArgoWorkflowOptions,
    "payloadConfigMapKey" | "payloadConfigMapName"
  >
): ArgoWorkflowVolume {
  return {
    configMap: {
      items: [{ key: options.payloadConfigMapKey, path: "payload.json" }],
      name: options.payloadConfigMapName,
    },
    name: "runner-payload",
  };
}

function runnerPayloadVolumeMount(): ArgoWorkflowVolumeMount {
  return {
    mountPath: RUNNER_WORKFLOW_PAYLOAD_PATH,
    name: "runner-payload",
    readOnly: true,
    subPath: "payload.json",
  };
}

function appendEventAuthStorage(
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[]
): void {
  if (!options.eventAuthSecretName) {
    return;
  }
  volumes.push({
    name: "runner-event-auth",
    secret: {
      ...(options.eventAuthSecretKey
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
}

function appendGitCredentialsStorage(
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[]
): void {
  if (!options.gitCredentialsSecretName) {
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
}

function appendGithubAuthStorage(
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[]
): void {
  if (!options.githubAuthSecretName) {
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
}

function appendNpmRegistryAuthStorage(
  options: RunnerWorkflowSecretOptions,
  volumes: ArgoWorkflowVolume[],
  volumeMounts: ArgoWorkflowVolumeMount[]
): void {
  if (!options.npmRegistryAuthSecretName) {
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
}
