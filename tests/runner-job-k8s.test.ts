import { describe, expect, it } from "vitest";

/**
 * RED: Kubernetes Job manifest builder.
 * Does not exist yet — every import and call will fail.
 *
 * Required coverage:
 *   (4) batch/v1 Job with no env/envFrom, payload ConfigMap volume,
 *       event Secret file volume, codex-auth/opencode-auth Secret
 *       volumes mounted at /root/.codex and /root/.local/share/opencode
 *       with key auth.json.
 *   (5) codex and opencode orchestrator/profile choices.
 */

function loadK8sModule() {
  return import("../src/runner-job/k8s.js");
}

const BASE_OPTIONS = {
  jobName: "pipeline-runner-default-red",
  namespace: "pipeline-runs",
  payloadConfigMapName: "pipeline-payload-default-red",
  payloadConfigMapKey: "payload.json",
  orchestrator: "codex" as const,
};

describe("runner-job K8s manifest builder", () => {
  describe("resource shape", () => {
    it("emits apiVersion batch/v1 and kind Job", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);

      expect(manifest).toMatchObject({
        apiVersion: "batch/v1",
        kind: "Job",
      });
    });

    it("sets metadata name from jobName option", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        jobName: "pipeline-runner-default-blue",
      });

      expect(manifest).toMatchObject({
        metadata: { name: "pipeline-runner-default-blue" },
      });
    });
  });

  describe("runner image", () => {
    it("uses the package-owned latest runner image with an explicit always-pull policy", async () => {
      const { RUNNER_JOB_IMAGE, buildRunnerJobK8sManifest } =
        await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);
      const container = manifest.spec.template.spec.containers[0];

      expect(RUNNER_JOB_IMAGE).toBe("ghcr.io/oisin-ee/pipeline-runner:latest");
      expect(container.image).toBe(RUNNER_JOB_IMAGE);
      expect(container.imagePullPolicy).toBe("Always");
    });

    it("does not let a caller-provided stale image override the package-owned image", async () => {
      const { RUNNER_JOB_IMAGE, buildRunnerJobK8sManifest } =
        await loadK8sModule();
      const staleOptions = {
        ...BASE_OPTIONS,
        image:
          "ghcr.io/oisin-ee/pipeline-runner:c9ab3ddd22ecddec8fabc5dad1fa706c5b10af10",
      };

      const manifest = buildRunnerJobK8sManifest(staleOptions);

      expect(manifest.spec.template.spec.containers[0].image).toBe(
        RUNNER_JOB_IMAGE
      );
    });
  });

  describe("image pull secrets", () => {
    it("sets imagePullSecrets when an imagePullSecretName is given", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        imagePullSecretName: "ghcr-pull-secret",
      });

      expect(manifest.spec.template.spec.imagePullSecrets).toEqual([
        { name: "ghcr-pull-secret" },
      ]);
    });

    it("omits imagePullSecrets when no imagePullSecretName is given", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);

      expect(manifest.spec.template.spec).not.toHaveProperty(
        "imagePullSecrets"
      );
    });
  });

  describe("container spec — env / envFrom", () => {
    it("does not set env on the runner container", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);
      const container = manifest.spec.template.spec.containers[0];

      expect(container).not.toHaveProperty("env");
    });

    it("does not set envFrom on the runner container", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);
      const container = manifest.spec.template.spec.containers[0];

      expect(container).not.toHaveProperty("envFrom");
    });
  });

  describe("payload ConfigMap volume", () => {
    it("includes a ConfigMap volume for the payload", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);
      const volumes = manifest.spec.template.spec.volumes;

      expect(volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "pipeline-payload-default-red",
            configMap: expect.objectContaining({
              name: "pipeline-payload-default-red",
              items: [{ key: "payload.json", path: "payload.json" }],
            }),
          }),
        ])
      );
    });

    it("mounts the payload ConfigMap at /etc/pipeline/payload.json", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);
      const container = manifest.spec.template.spec.containers[0];

      expect(container.volumeMounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "pipeline-payload-default-red",
            mountPath: "/etc/pipeline/payload.json",
            subPath: "payload.json",
            readOnly: true,
          }),
        ])
      );
    });
  });

  describe("event auth Secret volume", () => {
    it("mounts an event auth Secret file when eventAuthSecretName is given", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        eventAuthSecretName: "pipeline-event-auth",
        eventAuthSecretKey: "token",
      });
      const volumes = manifest.spec.template.spec.volumes;
      const container = manifest.spec.template.spec.containers[0];

      expect(volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "pipeline-event-auth",
            secret: expect.objectContaining({
              secretName: "pipeline-event-auth",
              items: [{ key: "token", path: "token" }],
            }),
          }),
        ])
      );
      expect(container.volumeMounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "pipeline-event-auth",
            mountPath: "/etc/pipeline/event-auth",
            readOnly: true,
          }),
        ])
      );
    });
  });

  describe("Codex auth Secret volume", () => {
    it("mounts codex-auth Secret as /root/.codex/auth.json with key auth.json", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        codexAuthSecretName: "codex-auth",
      });
      const volumes = manifest.spec.template.spec.volumes;
      const container = manifest.spec.template.spec.containers[0];

      expect(volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "codex-auth",
            secret: expect.objectContaining({
              secretName: "codex-auth",
              items: expect.arrayContaining([
                { key: "auth.json", path: "auth.json" },
              ]),
            }),
          }),
        ])
      );
      expect(container.volumeMounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "codex-auth",
            mountPath: "/root/.codex/auth.json",
            readOnly: true,
            subPath: "auth.json",
          }),
        ])
      );
    });

    it("skips codex auth volume when codexAuthSecretName is not given", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);
      const volumeNames = (
        manifest.spec.template.spec.volumes as Array<{ name: string }>
      ).map((v: { name: string }) => v.name);

      expect(volumeNames).not.toContain("codex-auth");
    });
  });

  describe("OpenCode auth Secret volume", () => {
    it("mounts opencode-auth Secret as /root/.local/share/opencode/auth.json with key auth.json", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        opencodeAuthSecretName: "opencode-auth",
      });
      const volumes = manifest.spec.template.spec.volumes;
      const container = manifest.spec.template.spec.containers[0];

      expect(volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "opencode-auth",
            secret: expect.objectContaining({
              secretName: "opencode-auth",
              items: expect.arrayContaining([
                { key: "auth.json", path: "auth.json" },
              ]),
            }),
          }),
        ])
      );
      expect(container.volumeMounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "opencode-auth",
            mountPath: "/root/.local/share/opencode/auth.json",
            readOnly: true,
            subPath: "auth.json",
          }),
        ])
      );
    });

    it("skips opencode auth volume when opencodeAuthSecretName is not given", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest(BASE_OPTIONS);
      const volumeNames = (
        manifest.spec.template.spec.volumes as Array<{ name: string }>
      ).map((v: { name: string }) => v.name);

      expect(volumeNames).not.toContain("opencode-auth");
    });
  });

  describe("GitHub auth Secret volume", () => {
    it("mounts oisin-bot GitHub auth files for git and gh", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        githubAuthSecretName: "oisin-bot-github-auth",
      });
      const volumes = manifest.spec.template.spec.volumes;
      const container = manifest.spec.template.spec.containers[0];

      expect(volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "oisin-bot-github-auth",
            secret: expect.objectContaining({
              secretName: "oisin-bot-github-auth",
              items: [
                { key: "gitconfig", path: "gitconfig" },
                { key: "git-credentials", path: "git-credentials" },
                { key: "hosts.yml", path: "hosts.yml" },
              ],
            }),
          }),
        ])
      );
      expect(container.volumeMounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "oisin-bot-github-auth",
            mountPath: "/root/.gitconfig",
            readOnly: true,
            subPath: "gitconfig",
          }),
          expect.objectContaining({
            name: "oisin-bot-github-auth",
            mountPath: "/root/.git-credentials",
            readOnly: true,
            subPath: "git-credentials",
          }),
          expect.objectContaining({
            name: "oisin-bot-github-auth",
            mountPath: "/root/.config/gh/hosts.yml",
            readOnly: true,
            subPath: "hosts.yml",
          }),
        ])
      );
    });
  });

  describe("orchestrator runner selection", () => {
    it("accepts codex orchestrator and passes runner-job, --payload-file, and orchestrator to container args", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        orchestrator: "codex",
      });
      const container = manifest.spec.template.spec.containers[0];

      expect(container.args).toEqual([
        "runner-job",
        "--payload-file",
        "/etc/pipeline/payload.json",
        "codex",
      ]);
    });

    it("accepts opencode orchestrator and passes runner-job, --payload-file, and orchestrator to container args", async () => {
      const { buildRunnerJobK8sManifest } = await loadK8sModule();

      const manifest = buildRunnerJobK8sManifest({
        ...BASE_OPTIONS,
        orchestrator: "opencode",
      });
      const container = manifest.spec.template.spec.containers[0];

      expect(container.args).toEqual([
        "runner-job",
        "--payload-file",
        "/etc/pipeline/payload.json",
        "opencode",
      ]);
    });
  });
});
