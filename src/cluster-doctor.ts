import { Effect } from "effect";

import { loadMokaGlobalConfig } from "./moka-global-config";
import { KubernetesArgoService, KubernetesArgoServiceLive } from "./runtime/services/kubernetes-argo-service";
import type { KubectlOptions, KubectlResult } from "./runtime/services/kubernetes-argo-service";

const DEFAULT_NAMESPACE = "momokaya-pipeline";
const DEFAULT_RESOURCES = {
  brokerAuthSecretName: "broker-api-key",
  eventAuthExternalSecretName: "pipeline-runner-event-auth",
  eventAuthSecretName: "pipeline-runner-event-auth",
  externalSecretRemoteRef: "agent-runtime/pipeline-runner/event-auth",
  gitCredentialsSecretName: "oisin-bot-git-credentials",
  githubAuthSecretName: "oisin-bot-github-auth",
  imagePullSecretName: "ghcr-pull-secret",
  serviceAccountName: "pipeline-runner",
};
const FORBIDDEN_RE = /forbidden/iu;

export interface ClusterDoctorOptions {
  kubeContext?: string;
  kubeconfigPath?: string;
  namespace?: string;
}

interface DoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

export interface ClusterDoctorResult {
  checks: DoctorCheck[];
  passed: boolean;
}

export const defaultClusterDoctorNamespace = (): string => DEFAULT_NAMESPACE;

const clusterResources = (): typeof DEFAULT_RESOURCES => {
  const configured = loadMokaGlobalConfig()?.momokaya.submit;
  return configured
    ? {
        ...DEFAULT_RESOURCES,
        // codex + opencode authenticate through the central broker secret; the
        // runner has no bespoke per-tool auth mount.
        brokerAuthSecretName: configured.brokerAuth.secretName,
        eventAuthSecretName: configured.eventAuthSecretName,
        gitCredentialsSecretName: configured.gitCredentialsSecretName,
        githubAuthSecretName: configured.githubAuthSecretName,
        imagePullSecretName: configured.imagePullSecretName,
        serviceAccountName: configured.serviceAccountName,
      }
    : DEFAULT_RESOURCES;
};

const eventAuthMissingDetail = (namespace: string): string =>
  `Secret pipeline-runner-event-auth missing in ${namespace}; expected ExternalSecret pipeline-runner-event-auth to sync it from agent-runtime/pipeline-runner/event-auth.`;

const readyDetail = (ready: Condition, passed: boolean): string => {
  const fallback = passed ? "Ready=True" : "Ready condition is missing or not True";
  return ready.message !== undefined && ready.message !== "" ? ready.message : fallback;
};

const kubectl = (args: string[], options: KubectlOptions): Effect.Effect<KubectlResult, never, KubernetesArgoService> =>
  Effect.gen(function* effectBody() {
    const service = yield* KubernetesArgoService;
    return yield* service.kubectl(args, options);
  });

const checkWorkflowSubmitPermission = (
  namespace: string,
  options: {
    kubeContext?: string;
    kubeconfigPath?: string;
    resource: string;
    verb: string;
  },
): Effect.Effect<DoctorCheck, never, KubernetesArgoService> =>
  kubectl(["auth", "can-i", options.verb, options.resource, "-n", namespace], options).pipe(
    Effect.map((result) =>
      result.stdout.trim() === "yes"
        ? {
            detail: `current kube identity can ${options.verb} ${options.resource}`,
            name: "rbac/workflow-create",
            passed: true,
          }
        : {
            detail: `current kube identity cannot ${options.verb} ${options.resource}; check submitter RBAC for Workflow creation.`,
            name: "rbac/workflow-create",
            passed: false,
          },
    ),
  );

const inaccessibleDetail = (name: string, result: KubectlResult): string =>
  `${name} inaccessible with the current kube identity: ${result.stderr}`;

const isForbidden = (result: KubectlResult): boolean => FORBIDDEN_RE.test(result.stderr);

const checkClusterResource = (
  name: string,
  args: string[],
  kubectlOptions: KubectlOptions,
): Effect.Effect<DoctorCheck, never, KubernetesArgoService> =>
  kubectl(args, kubectlOptions).pipe(
    Effect.map((result) =>
      result.ok
        ? { detail: "present", name, passed: true }
        : {
            detail: isForbidden(result) ? inaccessibleDetail(name, result) : result.stderr || "missing or inaccessible",
            name,
            passed: false,
          },
    ),
  );

const inaccessibleOrMissingDetail = (name: string, missingDetail: string, result: KubectlResult): string =>
  isForbidden(result) ? inaccessibleDetail(name, result) : missingDetail;

const checkNamespacedResource = (
  name: string,
  args: string[],
  missingDetail: string,
  kubectlOptions: KubectlOptions,
): Effect.Effect<DoctorCheck, never, KubernetesArgoService> =>
  kubectl(args, kubectlOptions).pipe(
    Effect.map((result) =>
      result.ok
        ? { detail: "present", name, passed: true }
        : {
            detail: inaccessibleOrMissingDetail(name, missingDetail, result),
            name,
            passed: false,
          },
    ),
  );

const checkServiceAccount = (
  namespace: string,
  name: string,
  kubectlOptions: KubectlOptions,
): Effect.Effect<DoctorCheck, never, KubernetesArgoService> =>
  checkNamespacedResource(
    `serviceaccount/${name}`,
    ["get", "serviceaccount", name, "-n", namespace],
    `ServiceAccount ${name} missing in ${namespace}; runner pods must use this account for workflow execution.`,
    kubectlOptions,
  );

const secretChecks = (
  namespace: string,
  kubectlOptions: KubectlOptions,
  resources: typeof DEFAULT_RESOURCES,
): Effect.Effect<DoctorCheck, never, KubernetesArgoService>[] => {
  // codex + opencode authenticate through the central broker; validate the
  // broker api-key secret is present.
  const authSecretCheck: [string, string] = [
    resources.brokerAuthSecretName,
    `Secret ${resources.brokerAuthSecretName} missing in ${namespace}; expected broker api-key mount by name.`,
  ];
  return [
    [resources.eventAuthSecretName, eventAuthMissingDetail(namespace)],
    [
      resources.imagePullSecretName,
      `Secret ${resources.imagePullSecretName} missing in ${namespace}; expected imagePullSecret for ghcr.io/oisin-ee/pipeline-runner.`,
    ],
    authSecretCheck,
    [
      resources.gitCredentialsSecretName,
      `Secret ${resources.gitCredentialsSecretName} missing in ${namespace}; expected runner git credentials mount by name.`,
    ],
    [
      resources.githubAuthSecretName,
      `Secret ${resources.githubAuthSecretName} missing in ${namespace}; expected GitHub auth mount by name.`,
    ],
  ].map(([name, missingDetail]) =>
    checkNamespacedResource(`secret/${name}`, ["get", "secret", name, "-n", namespace], missingDetail, kubectlOptions),
  );
};

const checkKubectlNamespace = (
  namespace: string,
  kubectlOptions: KubectlOptions,
): Effect.Effect<DoctorCheck, never, KubernetesArgoService> =>
  checkNamespacedResource(
    `namespace/${namespace}`,
    ["get", "namespace", namespace],
    `Namespace ${namespace} missing or inaccessible.`,
    kubectlOptions,
  );

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source);
  } catch {
    return {};
  }
};

const findReadyCondition = (source: string): Condition => {
  const status = parseJson(source) as { status?: { conditions?: Condition[] } };
  return status.status?.conditions?.find((condition) => condition.type === "Ready") ?? {};
};

const readyConditionCheck = (name: string, source: string): DoctorCheck => {
  const ready = findReadyCondition(source);
  const passed = ready.status === "True";
  return { detail: readyDetail(ready, passed), name, passed };
};

const checkExternalSecret = (
  namespace: string,
  name: string,
  remoteRef: string,
  kubectlOptions: KubectlOptions,
): Effect.Effect<DoctorCheck, never, KubernetesArgoService> =>
  kubectl(["get", "externalsecret", name, "-n", namespace, "-o", "json"], kubectlOptions).pipe(
    Effect.map((result) => {
      if (!result.ok) {
        const missingDetail = `ExternalSecret ${name} missing in ${namespace}; expected it to sync ${remoteRef}.`;
        return {
          detail: inaccessibleOrMissingDetail(`externalsecret/${name}`, missingDetail, result),
          name: `externalsecret/${name}`,
          passed: false,
        };
      }
      return readyConditionCheck(`externalsecret/${name}`, result.stdout);
    }),
  );

const checkClusterSecretStore = (
  name: string,
  kubectlOptions: KubectlOptions,
): Effect.Effect<DoctorCheck, never, KubernetesArgoService> =>
  kubectl(["get", "clustersecretstore", name, "-o", "json"], kubectlOptions).pipe(
    Effect.map((result) => {
      if (!result.ok) {
        const missingDetail = `ClusterSecretStore/${name} missing or inaccessible; OpenBao/ESO readiness is an external prerequisite.`;
        return {
          detail: inaccessibleOrMissingDetail(`clustersecretstore/${name}`, missingDetail, result),
          name: `clustersecretstore/${name}`,
          passed: false,
        };
      }
      return readyConditionCheck(`clustersecretstore/${name}`, result.stdout);
    }),
  );

const runClusterDoctorEffect = (
  options: ClusterDoctorOptions = {},
): Effect.Effect<ClusterDoctorResult, never, KubernetesArgoService> => {
  const resources = clusterResources();
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const kubectlOptions = {
    kubeContext: options.kubeContext,
    kubeconfigPath: options.kubeconfigPath,
  };
  return Effect.gen(function* effectBody() {
    const checks = yield* Effect.all(
      [
        checkKubectlNamespace(namespace, kubectlOptions),
        ...secretChecks(namespace, kubectlOptions, resources),
        checkExternalSecret(
          namespace,
          resources.eventAuthExternalSecretName,
          resources.externalSecretRemoteRef,
          kubectlOptions,
        ),
        checkClusterSecretStore("openbao", kubectlOptions),
        checkServiceAccount(namespace, resources.serviceAccountName, kubectlOptions),
        checkWorkflowSubmitPermission(namespace, {
          resource: "workflows.argoproj.io",
          verb: "create",
          ...kubectlOptions,
        }),
        checkClusterResource("argo-workflow-crd", ["get", "crd", "workflows.argoproj.io"], kubectlOptions),
        checkClusterResource(
          "argo-workflow-controller",
          ["get", "pods", "-A", "-l", "app=workflow-controller"],
          kubectlOptions,
        ),
      ],
      { concurrency: "unbounded" },
    );

    return {
      checks,
      passed: checks.every((check) => check.passed),
    };
  });
};

export const runClusterDoctor = async (options: ClusterDoctorOptions = {}): Promise<ClusterDoctorResult> =>
  await Effect.runPromise(
    Effect.provide(
      Effect.suspend(() => runClusterDoctorEffect(options)),
      KubernetesArgoServiceLive,
    ),
  );

interface Condition {
  message?: string;
  status?: string;
  type?: string;
}
