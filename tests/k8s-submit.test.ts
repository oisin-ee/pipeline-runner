import { beforeEach, describe, expect, it, vi } from "vitest";

const EXTRA_FIELD_RE = /unrecognized|unknown|extra/i;
const KEY_RE = /key/i;
const NAME_RE = /name/i;
const VALUE_RE = /unrecognized|unknown|value/i;
const PAYLOAD_CONFIG_MAP_RE = /^pipeline-payload-/;
const RUN_ID_RE = /^run-/;
const GIT_REMOTE_RE = /origin|remote|repository/i;
const KUBE_FAILURE_RE = /kubeconfig|cluster|kubernetes|unreachable/i;

interface JobBody {
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{
          env?: Array<{ name: string; value: string }>;
          volumeMounts?: Record<string, unknown>[];
        }>;
        serviceAccountName?: string;
        volumes?: Record<string, unknown>[];
      };
    };
  };
}

interface JobWithArgs {
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{ args?: string[] }>;
      };
    };
  };
}

const k8sMock = vi.hoisted(() => {
  const coreApi = {
    createNamespacedConfigMap: vi.fn<
      (namespace: string, body: Record<string, unknown>) => Promise<unknown>
    >(async () => ({ body: { metadata: { name: "created-config-map" } } })),
  };
  const batchApi = {
    createNamespacedJob: vi.fn<
      (namespace: string, body: Record<string, unknown>) => Promise<unknown>
    >(async () => ({ body: { metadata: { name: "created-job" } } })),
  };
  const loadFromDefault = vi.fn<() => void>(() => undefined);
  const loadFromFile = vi.fn<(path: string) => void>(() => undefined);

  class CoreV1Api {}
  class BatchV1Api {}
  class KubeConfig {
    loadFromDefault(): void {
      loadFromDefault();
    }

    loadFromFile(path: string): void {
      loadFromFile(path);
    }

    makeApiClient(apiType: unknown): typeof coreApi | typeof batchApi {
      if (apiType === CoreV1Api) {
        return coreApi;
      }
      return batchApi;
    }
  }

  return {
    BatchV1Api,
    CoreV1Api,
    KubeConfig,
    batchApi,
    coreApi,
    loadFromDefault,
    loadFromFile,
  };
});

const gitMock = vi.hoisted(() => {
  const client = {
    branch: vi.fn<() => Promise<{ current: string }>>(async () => ({
      current: "feature/k8s-submit",
    })),
    getConfig: vi.fn<(key: string) => Promise<{ value: string | undefined }>>(
      async (key) => ({
        value:
          key === "remote.origin.url"
            ? "https://github.com/oisin-ee/pipeline-runner.git"
            : undefined,
      })
    ),
    revparse: vi.fn<(args: string[]) => Promise<string>>((args) => {
      if (args.includes("HEAD")) {
        return Promise.resolve("0123456789abcdef0123456789abcdef01234567");
      }
      return Promise.resolve("main");
    }),
  };
  return {
    client,
    simpleGit: vi.fn(() => client),
  };
});

vi.mock("@kubernetes/client-node", () => ({
  BatchV1Api: k8sMock.BatchV1Api,
  CoreV1Api: k8sMock.CoreV1Api,
  KubeConfig: k8sMock.KubeConfig,
}));

vi.mock("simple-git", () => ({
  default: gitMock.simpleGit,
  simpleGit: gitMock.simpleGit,
}));

async function loadK8sSubmitModule() {
  return await import("../src/k8s-submit");
}

function getLastJobSpec() {
  const job = k8sMock.batchApi.createNamespacedJob.mock.calls[0]?.[1];
  return (job as JobBody | undefined)?.spec?.template?.spec;
}

function parsePayloadFromConfigMap(): Record<string, unknown> {
  const configMap =
    k8sMock.coreApi.createNamespacedConfigMap.mock.calls[0]?.[1];
  const data = configMap?.data as Record<string, string> | undefined;
  if (!data?.["payload.json"]) {
    throw new Error("payload ConfigMap must include data.payload.json");
  }
  return JSON.parse(data?.["payload.json"] ?? "{}");
}

beforeEach(() => {
  vi.clearAllMocks();
  k8sMock.coreApi.createNamespacedConfigMap.mockResolvedValue({
    body: { metadata: { name: "created-config-map" } },
  });
  k8sMock.batchApi.createNamespacedJob.mockResolvedValue({
    body: { metadata: { name: "created-job" } },
  });
  k8sMock.loadFromDefault.mockImplementation(() => undefined);
  k8sMock.loadFromFile.mockImplementation(() => undefined);
  gitMock.client.branch.mockResolvedValue({ current: "feature/k8s-submit" });
  gitMock.client.getConfig.mockImplementation((key) =>
    Promise.resolve({
      value:
        key === "remote.origin.url"
          ? "https://github.com/oisin-ee/pipeline-runner.git"
          : undefined,
    })
  );
  gitMock.client.revparse.mockImplementation((args) => {
    if (args.includes("HEAD")) {
      return Promise.resolve("0123456789abcdef0123456789abcdef01234567");
    }
    return Promise.resolve("main");
  });
});

describe("k8s-submit core submission", () => {
  it("defaults submit options and rejects unknown fields", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();

    await submitK8sRunnerJob({
      entrypoint: "quick",
      eventUrl: "https://events.example.test/runs/run-123/events",
      task: "Ship PIPE-53",
    });

    const payload = parsePayloadFromConfigMap();
    expect(payload).toMatchObject({
      command: "quick",
      events: {
        authTokenFile: "/etc/pipeline/event-auth/token",
        url: "https://events.example.test/runs/run-123/events",
      },
    });

    const job = k8sMock.batchApi.createNamespacedJob.mock.calls[0]?.[1];
    const podSpec = (job as JobBody | undefined)?.spec?.template?.spec;
    expect(podSpec?.serviceAccountName).toBe("pipeline-runner");

    await expect(
      submitK8sRunnerJob({
        entrypoint: "quick",
        eventUrl: "https://events.example.test/runs/run-123/events",
        extra: true,
        task: "Ship PIPE-53",
      } as never)
    ).rejects.toThrow(EXTRA_FIELD_RE);
  });

  it("rejects incomplete and over-specified secret refs", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();

    await expect(
      submitK8sRunnerJob({
        codexAuth: { name: "codex-auth-1" },
        entrypoint: "quick",
        eventUrl: "https://events.example.test/runs/run-123/events",
        task: "Ship PIPE-53",
      } as never)
    ).rejects.toThrow(KEY_RE);

    await expect(
      submitK8sRunnerJob({
        codexAuth: { key: "auth.json" },
        entrypoint: "quick",
        eventUrl: "https://events.example.test/runs/run-123/events",
        task: "Ship PIPE-53",
      } as never)
    ).rejects.toThrow(NAME_RE);

    await expect(
      submitK8sRunnerJob({
        codexAuth: {
          key: "auth.json",
          name: "codex-auth-1",
          value: "must-not-be-accepted",
        },
        entrypoint: "quick",
        eventUrl: "https://events.example.test/runs/run-123/events",
        task: "Ship PIPE-53",
      } as never)
    ).rejects.toThrow(VALUE_RE);
  });

  it("creates a payload ConfigMap and Job with the expected runner payload and auth mounts", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();

    const result = await submitK8sRunnerJob({
      entrypoint: "execute",
      eventUrl: "https://events.example.test/runs/run-123/events",
      jobName: "pipeline-run-execute-red",
      namespace: "pipeline-runs",
      orchestrator: "codex",
      task: "Implement PIPE-53",
    });

    expect(result).toEqual({
      jobName: "pipeline-run-execute-red",
      namespace: "pipeline-runs",
    });
    expect(k8sMock.coreApi.createNamespacedConfigMap).toHaveBeenCalledOnce();
    expect(k8sMock.batchApi.createNamespacedJob).toHaveBeenCalledOnce();
    expect(k8sMock.coreApi.createNamespacedConfigMap).toHaveBeenCalledWith(
      "pipeline-runs",
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: expect.stringMatching(PAYLOAD_CONFIG_MAP_RE),
          namespace: "pipeline-runs",
        }),
      })
    );
    expect(k8sMock.batchApi.createNamespacedJob).toHaveBeenCalledWith(
      "pipeline-runs",
      expect.objectContaining({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "pipeline-run-execute-red",
          namespace: "pipeline-runs",
        },
      })
    );

    const payload = parsePayloadFromConfigMap();
    expect(payload).toMatchObject({
      command: "execute",
      contractVersion: "1",
      events: {
        authTokenFile: "/etc/pipeline/event-auth/token",
        url: "https://events.example.test/runs/run-123/events",
      },
      repository: {
        baseBranch: "feature/k8s-submit",
        sha: "0123456789abcdef0123456789abcdef01234567",
        url: "https://github.com/oisin-ee/pipeline-runner.git",
      },
      run: {
        id: expect.stringMatching(RUN_ID_RE),
        project: "pipeline-runner",
      },
      task: { kind: "prompt", prompt: "Implement PIPE-53" },
    });

    const job = k8sMock.batchApi.createNamespacedJob.mock.calls[0]?.[1];
    const podSpec = (job as JobBody | undefined)?.spec?.template?.spec;
    const mounts = podSpec?.containers?.[0]?.volumeMounts ?? [];
    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mountPath: "/etc/pipeline/payload.json" }),
        expect.objectContaining({ mountPath: "/etc/pipeline/event-auth" }),
        expect.objectContaining({ mountPath: "/root/.codex/auth.json" }),
        expect.objectContaining({
          mountPath: "/root/.local/share/opencode/auth.json",
        }),
        expect.objectContaining({ mountPath: "/root/.gitconfig" }),
        expect.objectContaining({ mountPath: "/root/.git-credentials" }),
        expect.objectContaining({ mountPath: "/root/.config/gh/hosts.yml" }),
      ])
    );
    expect(podSpec?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "pipeline-runner-event-auth" }),
        expect.objectContaining({ name: "codex-auth-1" }),
        expect.objectContaining({ name: "opencode-auth-1" }),
        expect.objectContaining({ name: "pipeline-runner-github-auth" }),
      ])
    );
  });

  it("loads an explicit kubeconfig path before submitting", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();

    await submitK8sRunnerJob({
      entrypoint: "quick",
      eventUrl: "https://events.example.test/runs/run-123/events",
      kubeconfigPath: "/tmp/test-kubeconfig.yaml",
      task: "Implement PIPE-53",
    });

    expect(k8sMock.loadFromFile).toHaveBeenCalledWith(
      "/tmp/test-kubeconfig.yaml"
    );
    expect(k8sMock.loadFromDefault).not.toHaveBeenCalled();
  });

  it("submits quick as the runner payload command while keeping orchestrator as the job arg", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();

    await submitK8sRunnerJob({
      entrypoint: "quick",
      eventUrl: "https://events.example.test/runs/run-quick/events",
      jobName: "pipeline-run-quick-red",
      namespace: "pipeline-runs",
      orchestrator: "codex",
      task: "Investigate PIPE-53 quickly",
    });

    const payload = parsePayloadFromConfigMap();
    expect(payload).toMatchObject({
      command: "quick",
      events: { url: "https://events.example.test/runs/run-quick/events" },
      task: { kind: "prompt", prompt: "Investigate PIPE-53 quickly" },
    });

    const job = k8sMock.batchApi.createNamespacedJob.mock.calls[0]?.[1] as
      | JobWithArgs
      | undefined;
    expect(job?.spec?.template?.spec?.containers?.[0]?.args).toEqual([
      "runner-job",
      "--payload-file",
      "/etc/pipeline/payload.json",
      "codex",
    ]);
  });

  it("mounts the openai accounts secret at the global oc-codex-multi-auth path and sets the env var", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();

    await submitK8sRunnerJob({
      entrypoint: "execute",
      eventUrl: "https://events.example.test/runs/run-123/events",
      opencodeOpenaiAccounts: {
        key: "accounts.json",
        name: "opencode-openai-accounts-1",
      },
      task: "Implement PIPE-53",
    });

    const podSpec = getLastJobSpec();
    expect(podSpec?.containers?.[0]?.volumeMounts).toContainEqual(
      expect.objectContaining({
        mountPath: "/root/.opencode/oc-codex-multi-auth-accounts.json",
        name: "opencode-openai-accounts-1",
        subPath: "accounts.json",
      })
    );
    expect(podSpec?.volumes).toContainEqual(
      expect.objectContaining({ name: "opencode-openai-accounts-1" })
    );
    expect(podSpec?.containers?.[0]?.env).toContainEqual({
      name: "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
      value: "false",
    });
  });

  it("omits the openai accounts volume and env when opencodeOpenaiAccounts is not provided", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();

    await submitK8sRunnerJob({
      entrypoint: "execute",
      eventUrl: "https://events.example.test/runs/run-123/events",
      task: "Implement PIPE-53",
    });

    const podSpec = getLastJobSpec();
    expect(podSpec?.containers?.[0]?.volumeMounts).not.toContainEqual(
      expect.objectContaining({
        mountPath: "/root/.opencode/oc-codex-multi-auth-accounts.json",
      })
    );
    expect(podSpec?.containers?.[0]?.env).toBeUndefined();
  });

  it("throws descriptive errors for missing git remote and kube API failures", async () => {
    const { submitK8sRunnerJob } = await loadK8sSubmitModule();
    gitMock.client.getConfig.mockResolvedValue({ value: undefined });

    await expect(
      submitK8sRunnerJob({
        entrypoint: "quick",
        eventUrl: "https://events.example.test/runs/run-123/events",
        task: "Implement PIPE-53",
      })
    ).rejects.toThrow(GIT_REMOTE_RE);

    gitMock.client.getConfig.mockResolvedValue({
      value: "https://github.com/oisin-ee/pipeline-runner.git",
    });
    k8sMock.batchApi.createNamespacedJob.mockRejectedValue(
      new Error("connect ECONNREFUSED")
    );

    await expect(
      submitK8sRunnerJob({
        entrypoint: "quick",
        eventUrl: "https://events.example.test/runs/run-123/events",
        task: "Implement PIPE-53",
      })
    ).rejects.toThrow(KUBE_FAILURE_RE);
  });
});
