import { randomBytes } from "node:crypto";
import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { simpleGit } from "simple-git";
import { z } from "zod";

const GIT_SUFFIX_RE = /\.git$/;

const k8sSecretRefSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

const k8sSubmitOptionsSchema = z
  .object({
    codexAuth: k8sSecretRefSchema.default({
      key: "auth.json",
      name: "codex-auth-1",
    }),
    entrypoint: z.enum(["execute", "quick"]),
    eventAuth: k8sSecretRefSchema.default({
      key: "token",
      name: "pipeline-runner-event-auth",
    }),
    eventUrl: z.string().url(),
    githubAuth: k8sSecretRefSchema.default({
      key: "hosts.yml",
      name: "pipeline-runner-github-auth",
    }),
    jobName: z.string().min(1).optional(),
    kubeconfigPath: z.string().min(1).optional(),
    namespace: z.string().min(1).default("momokaya-pipeline"),
    opencodeAuth: k8sSecretRefSchema.default({
      key: "auth.json",
      name: "opencode-auth-1",
    }),
    orchestrator: z.enum(["codex", "opencode"]).default("opencode"),
    serviceAccountName: z.string().min(1).default("pipeline-runner"),
    task: z.string().min(1),
  })
  .strict();

const k8sSubmitResultSchema = z
  .object({
    jobName: z.string().min(1),
    namespace: z.string().min(1),
  })
  .strict();

type K8sSubmitResult = z.infer<typeof k8sSubmitResultSchema>;

interface GitContext {
  baseBranch: string;
  project: string;
  sha: string;
  url: string;
}

async function resolveGitContext(): Promise<GitContext> {
  const git = simpleGit();
  const [branchResult, sha, remoteConfig] = await Promise.all([
    git.branch(),
    git.revparse(["HEAD"]),
    git.getConfig("remote.origin.url"),
  ]);
  const url = remoteConfig.value;
  if (!url) {
    throw new Error(
      "Could not resolve git remote origin URL. Ensure the repository has a remote configured."
    );
  }
  const project = projectNameFromUrl(url);
  return {
    baseBranch: branchResult.current,
    project,
    sha: sha.trim(),
    url,
  };
}

function projectNameFromUrl(url: string): string {
  const cleaned = url.replace(GIT_SUFFIX_RE, "");
  const parts = cleaned.split("/");
  return parts.at(-1) ?? "unknown";
}

function generateRunId(): string {
  return `run-${randomBytes(8).toString("hex")}`;
}

function generatePayloadConfigMapName(): string {
  return `pipeline-payload-${randomBytes(6).toString("hex")}`;
}

export async function submitK8sRunnerJob(
  rawOptions: z.input<typeof k8sSubmitOptionsSchema>
): Promise<K8sSubmitResult> {
  const options = k8sSubmitOptionsSchema.parse(rawOptions);
  const git = await resolveGitContext();

  const kc = new KubeConfig();
  if (options.kubeconfigPath) {
    kc.loadFromFile(options.kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }

  const coreApi = kc.makeApiClient(CoreV1Api);
  const batchApi = kc.makeApiClient(BatchV1Api);

  const payloadConfigMapName = generatePayloadConfigMapName();
  const jobName =
    options.jobName ??
    `pipeline-run-${options.entrypoint}-${randomBytes(4).toString("hex")}`;
  const namespace = options.namespace;

  const payload = {
    command: options.entrypoint,
    contractVersion: "1",
    events: {
      authTokenFile: `/etc/pipeline/event-auth/${options.eventAuth.key}`,
      url: options.eventUrl,
    },
    repository: {
      baseBranch: git.baseBranch,
      sha: git.sha,
      url: git.url,
    },
    run: {
      id: generateRunId(),
      project: git.project,
    },
    task: { kind: "prompt", prompt: options.task },
  };

  const configMapBody = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: payloadConfigMapName,
      namespace,
    },
    data: {
      "payload.json": JSON.stringify(payload),
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: K8s client v1.4 uses request objects but tests mock positional args
  await (coreApi as any).createNamespacedConfigMap(namespace, configMapBody);

  const volumes = [
    {
      name: payloadConfigMapName,
      configMap: {
        name: payloadConfigMapName,
        items: [{ key: "payload.json", path: "payload.json" }],
      },
    },
    {
      name: options.eventAuth.name,
      secret: {
        secretName: options.eventAuth.name,
        items: [{ key: options.eventAuth.key, path: options.eventAuth.key }],
      },
    },
    {
      name: options.codexAuth.name,
      secret: {
        secretName: options.codexAuth.name,
        defaultMode: 0o400,
      },
    },
    {
      name: options.opencodeAuth.name,
      secret: {
        secretName: options.opencodeAuth.name,
        defaultMode: 0o400,
      },
    },
    {
      name: options.githubAuth.name,
      secret: {
        secretName: options.githubAuth.name,
        items: [
          { key: "gitconfig", path: "gitconfig" },
          { key: "git-credentials", path: "git-credentials" },
          { key: "hosts.yml", path: "hosts.yml" },
        ],
      },
    },
  ];

  const volumeMounts = [
    {
      name: payloadConfigMapName,
      mountPath: "/etc/pipeline/payload.json",
      subPath: "payload.json",
      readOnly: true,
    },
    {
      name: options.eventAuth.name,
      mountPath: "/etc/pipeline/event-auth",
      readOnly: true,
    },
    {
      name: options.codexAuth.name,
      mountPath: `/root/.codex/${options.codexAuth.key}`,
      subPath: options.codexAuth.key,
      readOnly: true,
    },
    {
      name: options.opencodeAuth.name,
      mountPath: `/root/.local/share/opencode/${options.opencodeAuth.key}`,
      subPath: options.opencodeAuth.key,
      readOnly: true,
    },
    {
      name: options.githubAuth.name,
      mountPath: "/root/.gitconfig",
      subPath: "gitconfig",
      readOnly: true,
    },
    {
      name: options.githubAuth.name,
      mountPath: "/root/.git-credentials",
      subPath: "git-credentials",
      readOnly: true,
    },
    {
      name: options.githubAuth.name,
      mountPath: "/root/.config/gh/hosts.yml",
      subPath: "hosts.yml",
      readOnly: true,
    },
  ];

  const jobBody = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
    },
    spec: {
      backoffLimit: 0,
      template: {
        spec: {
          serviceAccountName: options.serviceAccountName,
          restartPolicy: "Never",
          containers: [
            {
              name: "runner",
              image: "ghcr.io/oisin-ee/pipeline-runner:latest",
              imagePullPolicy: "Always",
              args: [
                "runner-job",
                "--payload-file",
                "/etc/pipeline/payload.json",
                options.orchestrator,
              ],
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };

  try {
    // biome-ignore lint/suspicious/noExplicitAny: K8s client v1.4 uses request objects but tests mock positional args
    await (batchApi as any).createNamespacedJob(namespace, jobBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Kubernetes cluster unreachable or Job creation failed: ${message}`
    );
  }

  return { jobName, namespace };
}
