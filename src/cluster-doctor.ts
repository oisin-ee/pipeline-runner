import { execa } from "execa";
import { loadMokaGlobalConfig } from "./moka-global-config";

const DEFAULT_NAMESPACE = "momokaya-pipeline";
const DEFAULT_RESOURCES = {
  eventAuthSecretName: "pipeline-runner-event-auth",
  eventAuthExternalSecretName: "pipeline-runner-event-auth",
  externalSecretRemoteRef: "agent-runtime/pipeline-runner/event-auth",
  gitCredentialsSecretName: "oisin-bot-git-credentials",
  githubAuthSecretName: "oisin-bot-github-auth",
  imagePullSecretName: "ghcr-pull-secret",
  opencodeAuthSecretName: "opencode-auth-1",
  queueName: "pipeline-runner",
  serviceAccountName: "pipeline-runner",
};

export interface ClusterDoctorOptions {
  kubeContext?: string;
  namespace?: string;
}

interface DoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  passed: boolean;
}

interface KubectlResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

export async function runClusterDoctor(
  options: ClusterDoctorOptions = {}
): Promise<DoctorResult> {
  const resources = clusterResources();
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const checks = await Promise.all([
    checkKubectlNamespace(namespace, options.kubeContext),
    ...secretChecks(namespace, options.kubeContext, resources),
    checkExternalSecret(
      namespace,
      resources.eventAuthExternalSecretName,
      resources.externalSecretRemoteRef,
      options.kubeContext
    ),
    checkClusterSecretStore("openbao", options.kubeContext),
    checkServiceAccount(
      namespace,
      resources.serviceAccountName,
      options.kubeContext
    ),
    checkServiceAccountPermission(namespace, resources.serviceAccountName, {
      kubeContext: options.kubeContext,
      resource: "workflows.argoproj.io",
      verb: "create",
    }),
    checkLocalQueue(namespace, resources.queueName, options.kubeContext),
    checkClusterResource(
      "argo-workflow-crd",
      ["get", "crd", "workflows.argoproj.io"],
      options.kubeContext
    ),
    checkClusterResource(
      "argo-workflow-controller",
      ["get", "pods", "-A", "-l", "app=workflow-controller"],
      options.kubeContext
    ),
  ]);

  return {
    checks,
    passed: checks.every((check) => check.passed),
  };
}

export function defaultClusterDoctorNamespace(): string {
  return DEFAULT_NAMESPACE;
}

function clusterResources(): typeof DEFAULT_RESOURCES {
  const configured = loadMokaGlobalConfig()?.momokaya.submit;
  return configured
    ? {
        ...DEFAULT_RESOURCES,
        eventAuthSecretName: configured.eventAuthSecretName,
        gitCredentialsSecretName: configured.gitCredentialsSecretName,
        githubAuthSecretName: configured.githubAuthSecretName,
        imagePullSecretName: configured.imagePullSecretName,
        opencodeAuthSecretName: configured.opencodeAuthSecretName,
        queueName: configured.queueName,
        serviceAccountName: configured.serviceAccountName,
      }
    : DEFAULT_RESOURCES;
}

function secretChecks(
  namespace: string,
  kubeContext: string | undefined,
  resources: typeof DEFAULT_RESOURCES
): Promise<DoctorCheck>[] {
  return [
    [resources.eventAuthSecretName, eventAuthMissingDetail(namespace)],
    [
      resources.imagePullSecretName,
      `Secret ${resources.imagePullSecretName} missing in ${namespace}; expected imagePullSecret for ghcr.io/oisin-ee/pipeline-runner.`,
    ],
    [
      resources.opencodeAuthSecretName,
      `Secret ${resources.opencodeAuthSecretName} missing in ${namespace}; expected OpenCode auth mount by name.`,
    ],
    [
      resources.gitCredentialsSecretName,
      `Secret ${resources.gitCredentialsSecretName} missing in ${namespace}; expected runner git credentials mount by name.`,
    ],
    [
      resources.githubAuthSecretName,
      `Secret ${resources.githubAuthSecretName} missing in ${namespace}; expected GitHub auth mount by name.`,
    ],
  ].map(([name, missingDetail]) =>
    checkNamespacedResource(
      `secret/${name}`,
      ["get", "secret", name, "-n", namespace],
      missingDetail,
      kubeContext
    )
  );
}

function eventAuthMissingDetail(namespace: string): string {
  return `Secret pipeline-runner-event-auth missing in ${namespace}; expected ExternalSecret pipeline-runner-event-auth to sync it from agent-runtime/pipeline-runner/event-auth.`;
}

function checkKubectlNamespace(
  namespace: string,
  kubeContext: string | undefined
): Promise<DoctorCheck> {
  return checkNamespacedResource(
    `namespace/${namespace}`,
    ["get", "namespace", namespace],
    `Namespace ${namespace} missing or inaccessible.`,
    kubeContext
  );
}

async function checkNamespacedResource(
  name: string,
  args: string[],
  missingDetail: string,
  kubeContext: string | undefined
): Promise<DoctorCheck> {
  const result = await kubectl(args, kubeContext);
  return result.ok
    ? { detail: "present", name, passed: true }
    : { detail: missingDetail, name, passed: false };
}

async function checkExternalSecret(
  namespace: string,
  name: string,
  remoteRef: string,
  kubeContext: string | undefined
): Promise<DoctorCheck> {
  const result = await kubectl(
    ["get", "externalsecret", name, "-n", namespace, "-o", "json"],
    kubeContext
  );
  if (!result.ok) {
    return {
      detail: `ExternalSecret ${name} missing in ${namespace}; expected it to sync ${remoteRef}.`,
      name: `externalsecret/${name}`,
      passed: false,
    };
  }
  return readyConditionCheck(`externalsecret/${name}`, result.stdout);
}

async function checkClusterSecretStore(
  name: string,
  kubeContext: string | undefined
): Promise<DoctorCheck> {
  const result = await kubectl(
    ["get", "clustersecretstore", name, "-o", "json"],
    kubeContext
  );
  if (!result.ok) {
    return {
      detail: `ClusterSecretStore/${name} missing or inaccessible; OpenBao/ESO readiness is an external prerequisite.`,
      name: `clustersecretstore/${name}`,
      passed: false,
    };
  }
  return readyConditionCheck(`clustersecretstore/${name}`, result.stdout);
}

function checkServiceAccount(
  namespace: string,
  name: string,
  kubeContext: string | undefined
): Promise<DoctorCheck> {
  return checkNamespacedResource(
    `serviceaccount/${name}`,
    ["get", "serviceaccount", name, "-n", namespace],
    `ServiceAccount ${name} missing in ${namespace}; runner pods must use this account for workflow execution.`,
    kubeContext
  );
}

async function checkServiceAccountPermission(
  namespace: string,
  serviceAccountName: string,
  options: {
    kubeContext?: string;
    resource: string;
    verb: string;
  }
): Promise<DoctorCheck> {
  const subject = `system:serviceaccount:${namespace}:${serviceAccountName}`;
  const result = await kubectl(
    [
      "auth",
      "can-i",
      options.verb,
      options.resource,
      "--as",
      subject,
      "-n",
      namespace,
    ],
    options.kubeContext
  );
  return result.stdout.trim() === "yes"
    ? {
        detail: `${subject} can ${options.verb} ${options.resource}`,
        name: "rbac/workflow-create",
        passed: true,
      }
    : {
        detail: `${subject} cannot ${options.verb} ${options.resource}; check runner ServiceAccount RBAC.`,
        name: "rbac/workflow-create",
        passed: false,
      };
}

function checkLocalQueue(
  namespace: string,
  queueName: string,
  kubeContext: string | undefined
): Promise<DoctorCheck> {
  return checkNamespacedResource(
    `localqueue/${queueName}`,
    ["get", "localqueue", queueName, "-n", namespace],
    `Kueue LocalQueue ${queueName} missing in ${namespace}; runner Workflow pods cannot be admitted to the expected queue.`,
    kubeContext
  );
}

async function checkClusterResource(
  name: string,
  args: string[],
  kubeContext: string | undefined
): Promise<DoctorCheck> {
  const result = await kubectl(args, kubeContext);
  return result.ok
    ? { detail: "present", name, passed: true }
    : {
        detail: result.stderr || "missing or inaccessible",
        name,
        passed: false,
      };
}

function readyConditionCheck(name: string, source: string): DoctorCheck {
  const status = parseJson(source) as { status?: { conditions?: Condition[] } };
  const ready = status.status?.conditions?.find(
    (condition) => condition.type === "Ready"
  );
  return ready?.status === "True"
    ? { detail: ready.message || "Ready=True", name, passed: true }
    : {
        detail: ready?.message || "Ready condition is missing or not True",
        name,
        passed: false,
      };
}

async function kubectl(
  args: string[],
  kubeContext: string | undefined
): Promise<KubectlResult> {
  try {
    const result = await execa("kubectl", kubectlArgs(args, kubeContext), {
      stdin: "ignore",
    });
    return { ok: true, stderr: result.stderr, stdout: result.stdout };
  } catch (err) {
    const error = err as {
      shortMessage?: string;
      stderr?: string;
      stdout?: string;
    };
    return {
      ok: false,
      stderr: (error.stderr || error.shortMessage || "kubectl failed").trim(),
      stdout: (error.stdout || "").trim(),
    };
  }
}

function kubectlArgs(
  args: string[],
  kubeContext: string | undefined
): string[] {
  return kubeContext ? ["--context", kubeContext, ...args] : args;
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return {};
  }
}

interface Condition {
  message?: string;
  status?: string;
  type?: string;
}
