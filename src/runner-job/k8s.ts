export interface BuildRunnerJobK8sManifestOptions {
  codexAuthSecretName?: string;
  eventAuthSecretKey?: string;
  eventAuthSecretName?: string;
  image: string;
  imagePullSecretName?: string;
  jobName: string;
  namespace: string;
  opencodeAuthSecretName?: string;
  orchestrator: "codex" | "opencode";
  payloadConfigMapKey: string;
  payloadConfigMapName: string;
}

export interface K8sJobManifest {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: { name: string; namespace: string };
  spec: {
    backoffLimit: number;
    template: {
      spec: {
        containers: Array<{
          args: string[];
          image: string;
          name: string;
          volumeMounts: Array<{
            mountPath: string;
            name: string;
            readOnly?: boolean;
            subPath?: string;
          }>;
        }>;
        imagePullSecrets?: Array<{ name: string }>;
        restartPolicy: string;
        volumes: Array<{
          configMap?: {
            items: Array<{ key: string; path: string }>;
            name: string;
          };
          name: string;
          secret?: {
            items: Array<{ key: string; path: string }>;
            secretName: string;
          };
        }>;
      };
    };
  };
}

export function buildRunnerJobK8sManifest(
  options: BuildRunnerJobK8sManifestOptions
): K8sJobManifest {
  const volumes: K8sJobManifest["spec"]["template"]["spec"]["volumes"] = [];
  const volumeMounts: K8sJobManifest["spec"]["template"]["spec"]["containers"][0]["volumeMounts"] =
    [];

  // Payload ConfigMap volume
  volumes.push({
    name: options.payloadConfigMapName,
    configMap: {
      name: options.payloadConfigMapName,
      items: [{ key: options.payloadConfigMapKey, path: "payload.json" }],
    },
  });
  volumeMounts.push({
    name: options.payloadConfigMapName,
    mountPath: "/etc/pipeline/payload.json",
    subPath: "payload.json",
    readOnly: true,
  });

  // Event auth Secret volume
  if (options.eventAuthSecretName) {
    const authItems = options.eventAuthSecretKey
      ? [{ key: options.eventAuthSecretKey, path: options.eventAuthSecretKey }]
      : [];
    volumes.push({
      name: options.eventAuthSecretName,
      secret: {
        secretName: options.eventAuthSecretName,
        items: authItems,
      },
    });
    volumeMounts.push({
      name: options.eventAuthSecretName,
      mountPath: "/etc/pipeline/event-auth",
      readOnly: true,
    });
  }

  // Codex auth Secret volume
  if (options.codexAuthSecretName) {
    volumes.push({
      name: options.codexAuthSecretName,
      secret: {
        secretName: options.codexAuthSecretName,
        items: [{ key: "auth.json", path: "auth.json" }],
      },
    });
    volumeMounts.push({
      name: options.codexAuthSecretName,
      mountPath: "/root/.codex/auth.json",
      subPath: "auth.json",
      readOnly: true,
    });
  }

  // OpenCode auth Secret volume
  if (options.opencodeAuthSecretName) {
    volumes.push({
      name: options.opencodeAuthSecretName,
      secret: {
        secretName: options.opencodeAuthSecretName,
        items: [{ key: "auth.json", path: "auth.json" }],
      },
    });
    volumeMounts.push({
      name: options.opencodeAuthSecretName,
      mountPath: "/root/.local/share/opencode/auth.json",
      subPath: "auth.json",
      readOnly: true,
    });
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: options.jobName,
      namespace: options.namespace,
    },
    spec: {
      backoffLimit: 0,
      template: {
        spec: {
          containers: [
            {
              args: [
                "runner-job",
                "--payload-file",
                "/etc/pipeline/payload.json",
                options.orchestrator,
              ],
              image: options.image,
              name: "pipeline-runner",
              volumeMounts,
            },
          ],
          ...(options.imagePullSecretName
            ? { imagePullSecrets: [{ name: options.imagePullSecretName }] }
            : {}),
          restartPolicy: "Never",
          volumes,
        },
      },
    },
  };
}
