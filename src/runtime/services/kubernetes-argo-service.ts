import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
} from "@kubernetes/client-node";
import { Context, Effect, Layer } from "effect";
import { execa } from "execa";
import type { WorkflowPhase, WorkflowReadApi } from "../../loop/argo-poll";
import { classifyArgoPhase, extractArgoRawPhase } from "../../loop/argo-poll";

export type { WorkflowReadApi } from "../../loop/argo-poll";
export type CoreApi = Pick<CoreV1Api, "createNamespacedConfigMap">;
export type WorkflowApi = Pick<
  CustomObjectsApi,
  "createNamespacedCustomObject"
>;

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
    readonly getWorkflowPhase: (input: {
      readonly dependencies: KubernetesArgoIoDependencies;
      readonly name: string;
      readonly namespace: string;
      readonly options: KubernetesArgoClientOptions;
    }) => Effect.Effect<WorkflowPhase, unknown>;
    readonly kubectl: (
      args: readonly string[],
      options: KubectlOptions
    ) => Effect.Effect<KubectlResult>;
  }
>()("KubernetesArgoService") {}

export const KubernetesArgoServiceLive = Layer.succeed(KubernetesArgoService, {
  createConfigMap: ({ body, dependencies, namespace, options }) =>
    Effect.try({
      try: () => apiClients(options, dependencies),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap(({ coreApi }) =>
        Effect.tryPromise({
          try: () => coreApi.createNamespacedConfigMap({ body, namespace }),
          catch: (error) => error,
        })
      )
    ),
  createWorkflow: ({ body, dependencies, namespace, options }) =>
    Effect.try({
      try: () => apiClients(options, dependencies),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap(({ workflowApi }) =>
        Effect.tryPromise({
          try: () =>
            workflowApi.createNamespacedCustomObject({
              body,
              group: "argoproj.io",
              namespace,
              plural: "workflows",
              version: "v1alpha1",
            }),
          catch: (error) => error,
        })
      )
    ),
  getWorkflowPhase: ({ dependencies, name, namespace, options }) =>
    Effect.try({
      try: () => readApiClient(options, dependencies),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((workflowReadApi) =>
        Effect.tryPromise({
          try: () =>
            workflowReadApi.getNamespacedCustomObject({
              group: "argoproj.io",
              name,
              namespace,
              plural: "workflows",
              version: "v1alpha1",
            }),
          catch: (error) => error,
        })
      ),
      Effect.map((resource) => classifyArgoPhase(extractArgoRawPhase(resource)))
    ),
  kubectl: (args, options) =>
    Effect.tryPromise({
      try: () =>
        execa("kubectl", kubectlArgs(args, options.kubeContext), {
          env: options.kubeconfigPath
            ? { KUBECONFIG: options.kubeconfigPath }
            : undefined,
          stdin: "ignore",
        }),
      catch: (error) => error,
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
});

export function resolveKubeConfig(
  options: KubernetesArgoClientOptions,
  dependencies: KubernetesArgoIoDependencies
): KubeConfig {
  if (dependencies.kubeConfig) {
    return dependencies.kubeConfig;
  }
  const kubeConfig = new KubeConfig();
  if (options.kubeconfigPath) {
    kubeConfig.loadFromFile(options.kubeconfigPath);
  } else {
    kubeConfig.loadFromDefault();
  }
  if (options.kubeContext) {
    if (!kubeConfig.getContextObject(options.kubeContext)) {
      throw new Error(
        `Kube context '${options.kubeContext}' was not found in the resolved kubeconfig`
      );
    }
    kubeConfig.setCurrentContext(options.kubeContext);
  }
  return kubeConfig;
}

function apiClients(
  options: KubernetesArgoClientOptions,
  dependencies: KubernetesArgoIoDependencies
): { coreApi: CoreApi; workflowApi: WorkflowApi } {
  if (dependencies.coreApi && dependencies.workflowApi) {
    return {
      coreApi: dependencies.coreApi,
      workflowApi: dependencies.workflowApi,
    };
  }
  return buildApiClients(
    resolveKubeConfig(options, dependencies),
    dependencies
  );
}

function buildApiClients(
  kubeConfig: KubeConfig,
  dependencies: KubernetesArgoIoDependencies
): { coreApi: CoreApi; workflowApi: WorkflowApi } {
  return {
    coreApi: dependencies.coreApi ?? kubeConfig.makeApiClient(CoreV1Api),
    workflowApi:
      dependencies.workflowApi ?? kubeConfig.makeApiClient(CustomObjectsApi),
  };
}

function readApiClient(
  options: KubernetesArgoClientOptions,
  dependencies: KubernetesArgoIoDependencies
): WorkflowReadApi {
  if (dependencies.workflowReadApi) {
    return dependencies.workflowReadApi;
  }
  return resolveKubeConfig(options, dependencies).makeApiClient(
    CustomObjectsApi
  );
}

function kubectlArgs(
  args: readonly string[],
  kubeContext: string | undefined
): string[] {
  return kubeContext ? ["--context", kubeContext, ...args] : [...args];
}

function kubectlErrorStderr(error: unknown): string {
  const parsed = error as {
    readonly shortMessage?: string;
    readonly stderr?: string;
  };
  return (parsed.stderr || parsed.shortMessage || "kubectl failed").trim();
}

function kubectlErrorStdout(error: unknown): string {
  const parsed = error as { readonly stdout?: string };
  return (parsed.stdout || "").trim();
}
