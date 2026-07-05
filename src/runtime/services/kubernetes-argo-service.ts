import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";
import { Context, Effect, Layer } from "effect";
import { getOrElse, isSome, none, some } from "effect/Option";
import type { Option } from "effect/Option";
import { execa } from "execa";

import type { WorkflowPhase, WorkflowReadApi } from "../../loop/argo-poll";
import { classifyArgoPhase, extractArgoRawPhase } from "../../loop/argo-poll";

export type { WorkflowReadApi } from "../../loop/argo-poll";
export interface CoreApi {
  readonly createNamespacedConfigMap: (
    param: Parameters<CoreV1Api["createNamespacedConfigMap"]>[0],
    options?: Parameters<CoreV1Api["createNamespacedConfigMap"]>[1]
  ) => Promise<unknown>;
  readonly deleteNamespacedConfigMap: (
    param: Parameters<CoreV1Api["deleteNamespacedConfigMap"]>[0],
    options?: Parameters<CoreV1Api["deleteNamespacedConfigMap"]>[1]
  ) => Promise<unknown>;
  readonly patchNamespacedConfigMap: (
    param: Parameters<CoreV1Api["patchNamespacedConfigMap"]>[0],
    options?: Parameters<CoreV1Api["patchNamespacedConfigMap"]>[1]
  ) => Promise<unknown>;
}
export interface WorkflowApi {
  readonly createNamespacedCustomObject: (param: {
    readonly body: unknown;
    readonly group: string;
    readonly namespace: string;
    readonly plural: string;
    readonly version: string;
  }) => Promise<unknown>;
}

export interface KubernetesOwnerReference {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
}

export interface ConfigMapOwnerReferencesPatch {
  readonly metadata: {
    readonly ownerReferences: readonly KubernetesOwnerReference[];
  };
}

export interface KubernetesArgoIoDependencies {
  coreApi?: CoreApi;
  kubeConfig?: KubeConfig;
  workflowApi?: WorkflowApi;
  workflowReadApi?: WorkflowReadApi;
}

export interface KubernetesArgoClientOptions {
  kubeContext?: string;
  kubeconfigPath?: string;
}

export interface KubectlOptions {
  kubeContext?: string;
  kubeconfigPath?: string;
}

export interface KubectlResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (value: unknown, field: string): Option<string> => {
  if (!isUnknownRecord(value)) {
    return none();
  }
  const fieldValue = value[field];
  return typeof fieldValue === "string" ? some(fieldValue) : none();
};

const textOption = (value?: string): Option<string> =>
  value === undefined || value.length === 0 ? none() : some(value);

export class KubernetesArgoService extends Context.Service<
  KubernetesArgoService,
  {
    readonly createConfigMap: (input: {
      readonly body: Parameters<
        CoreApi["createNamespacedConfigMap"]
      >[0]["body"];
      readonly dependencies: KubernetesArgoIoDependencies;
      readonly namespace: string;
      readonly options: KubernetesArgoClientOptions;
    }) => Effect.Effect<unknown, unknown>;
    readonly createWorkflow: (input: {
      readonly body: Parameters<
        WorkflowApi["createNamespacedCustomObject"]
      >[0]["body"];
      readonly dependencies: KubernetesArgoIoDependencies;
      readonly namespace: string;
      readonly options: KubernetesArgoClientOptions;
    }) => Effect.Effect<unknown, unknown>;
    readonly deleteConfigMap: (input: {
      readonly dependencies: KubernetesArgoIoDependencies;
      readonly name: string;
      readonly namespace: string;
      readonly options: KubernetesArgoClientOptions;
    }) => Effect.Effect<unknown, unknown>;
    readonly getWorkflowPhase: (input: {
      readonly dependencies: KubernetesArgoIoDependencies;
      readonly name: string;
      readonly namespace: string;
      readonly options: KubernetesArgoClientOptions;
    }) => Effect.Effect<WorkflowPhase, unknown>;
    readonly patchConfigMapOwnerReferences: (input: {
      readonly body: ConfigMapOwnerReferencesPatch;
      readonly dependencies: KubernetesArgoIoDependencies;
      readonly name: string;
      readonly namespace: string;
      readonly options: KubernetesArgoClientOptions;
    }) => Effect.Effect<unknown, unknown>;
    readonly kubectl: (
      args: readonly string[],
      options: KubectlOptions
    ) => Effect.Effect<KubectlResult>;
  }
>()("KubernetesArgoService") {}

export const resolveKubeConfig = (
  options: KubernetesArgoClientOptions,
  dependencies: KubernetesArgoIoDependencies
): KubeConfig => {
  if (dependencies.kubeConfig !== undefined) {
    return dependencies.kubeConfig;
  }
  const kubeConfig = new KubeConfig();
  const kubeconfigPath = textOption(options.kubeconfigPath);
  if (isSome(kubeconfigPath)) {
    kubeConfig.loadFromFile(kubeconfigPath.value);
  } else {
    kubeConfig.loadFromDefault();
  }
  const kubeContext = textOption(options.kubeContext);
  if (isSome(kubeContext)) {
    const contextObject = kubeConfig.getContextObject(kubeContext.value);
    if (contextObject === null) {
      throw new Error(
        `Kube context '${kubeContext.value}' was not found in the resolved kubeconfig`
      );
    }
    kubeConfig.setCurrentContext(kubeContext.value);
  }
  return kubeConfig;
};

const buildApiClients = (
  kubeConfig: KubeConfig,
  dependencies: KubernetesArgoIoDependencies
): { coreApi: CoreApi; workflowApi: WorkflowApi } => ({
  coreApi: dependencies.coreApi ?? kubeConfig.makeApiClient(CoreV1Api),
  workflowApi:
    dependencies.workflowApi ?? kubeConfig.makeApiClient(CustomObjectsApi),
});

const apiClients = (
  options: KubernetesArgoClientOptions,
  dependencies: KubernetesArgoIoDependencies
): { coreApi: CoreApi; workflowApi: WorkflowApi } => {
  if (
    dependencies.coreApi !== undefined &&
    dependencies.workflowApi !== undefined
  ) {
    return {
      coreApi: dependencies.coreApi,
      workflowApi: dependencies.workflowApi,
    };
  }
  return buildApiClients(
    resolveKubeConfig(options, dependencies),
    dependencies
  );
};

const readApiClient = (
  options: KubernetesArgoClientOptions,
  dependencies: KubernetesArgoIoDependencies
): WorkflowReadApi => {
  if (dependencies.workflowReadApi !== undefined) {
    return dependencies.workflowReadApi;
  }
  return resolveKubeConfig(options, dependencies).makeApiClient(
    CustomObjectsApi
  );
};

const kubectlArgs = (
  args: readonly string[],
  kubeContext?: string
): string[] => {
  const context = textOption(kubeContext);
  return isSome(context) ? ["--context", context.value, ...args] : [...args];
};

const kubectlErrorStderr = (error: unknown): string => {
  const stderr = stringField(error, "stderr");
  if (isSome(stderr)) {
    return stderr.value.trim();
  }
  const shortMessage = stringField(error, "shortMessage");
  return getOrElse(shortMessage, () => "kubectl failed").trim();
};

const kubectlErrorStdout = (error: unknown): string =>
  getOrElse(stringField(error, "stdout"), () => "").trim();

export const KubernetesArgoServiceLive = Layer.succeed(KubernetesArgoService, {
  createConfigMap: ({ body, dependencies, namespace, options }) =>
    Effect.try({
      catch: (error) => error,
      try: () => apiClients(options, dependencies),
    }).pipe(
      Effect.flatMap(({ coreApi }) =>
        Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await coreApi.createNamespacedConfigMap({ body, namespace }),
        })
      )
    ),
  createWorkflow: ({ body, dependencies, namespace, options }) =>
    Effect.try({
      catch: (error) => error,
      try: () => apiClients(options, dependencies),
    }).pipe(
      Effect.flatMap(({ workflowApi }) =>
        Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await workflowApi.createNamespacedCustomObject({
              body,
              group: "argoproj.io",
              namespace,
              plural: "workflows",
              version: "v1alpha1",
            }),
        })
      )
    ),
  deleteConfigMap: ({ dependencies, name, namespace, options }) =>
    Effect.try({
      catch: (error) => error,
      try: () => apiClients(options, dependencies),
    }).pipe(
      Effect.flatMap(({ coreApi }) =>
        Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await coreApi.deleteNamespacedConfigMap({ name, namespace }),
        })
      )
    ),
  getWorkflowPhase: ({ dependencies, name, namespace, options }) =>
    Effect.try({
      catch: (error) => error,
      try: () => readApiClient(options, dependencies),
    }).pipe(
      Effect.flatMap((workflowReadApi) =>
        Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await workflowReadApi.getNamespacedCustomObject({
              group: "argoproj.io",
              name,
              namespace,
              plural: "workflows",
              version: "v1alpha1",
            }),
        })
      ),
      Effect.map((resource) => classifyArgoPhase(extractArgoRawPhase(resource)))
    ),
  kubectl: (args, options) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        const kubeconfigPath = textOption(options.kubeconfigPath);
        return await execa("kubectl", kubectlArgs(args, options.kubeContext), {
          env: isSome(kubeconfigPath)
            ? { KUBECONFIG: kubeconfigPath.value }
            : undefined,
          stdin: "ignore",
        });
      },
    }).pipe(
      Effect.map((result) => ({
        ok: true,
        stderr: result.stderr,
        stdout: result.stdout,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false,
          stderr: kubectlErrorStderr(error),
          stdout: kubectlErrorStdout(error),
        })
      )
    ),
  patchConfigMapOwnerReferences: ({
    body,
    dependencies,
    name,
    namespace,
    options,
  }) =>
    Effect.try({
      catch: (error) => error,
      try: () => apiClients(options, dependencies),
    }).pipe(
      Effect.flatMap(({ coreApi }) =>
        Effect.tryPromise({
          catch: (error) => error,
          try: async () =>
            await coreApi.patchNamespacedConfigMap(
              { body, name, namespace },
              setHeaderOptions("Content-Type", PatchStrategy.MergePatch)
            ),
        })
      )
    ),
});
