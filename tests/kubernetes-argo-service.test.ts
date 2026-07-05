import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { resolveKubeConfig } from "../src/runtime/services/kubernetes-argo-service";

const KUBECONFIG_DIR = mkdtempSync(join(tmpdir(), "kubernetes-argo-service-"));
const KUBECONFIG_PATH = join(KUBECONFIG_DIR, "config.yaml");

// Two contexts sharing one file, mirroring a local orbstack context living
// alongside a remote momokaya cluster context in a single kubeconfig.
writeFileSync(
  KUBECONFIG_PATH,
  `
apiVersion: v1
kind: Config
clusters:
  - name: momokaya
    cluster:
      server: https://momokaya.example:6443
  - name: orbstack
    cluster:
      server: https://orbstack.local:6443
contexts:
  - name: momokaya
    context:
      cluster: momokaya
  - name: orbstack
    context:
      cluster: orbstack
current-context: momokaya
users: []
`.trimStart()
);

afterAll(() => {
  rmSync(KUBECONFIG_DIR, { force: true, recursive: true });
});

describe("resolveKubeConfig", () => {
  it("defaults to the kubeconfig's current-context when kubeContext is not set", () => {
    const kubeConfig = resolveKubeConfig(
      { kubeconfigPath: KUBECONFIG_PATH },
      {}
    );
    expect(kubeConfig.getCurrentContext()).toBe("momokaya");
  });

  it("selects the requested context out of a kubeconfig with multiple contexts", () => {
    const kubeConfig = resolveKubeConfig(
      { kubeContext: "orbstack", kubeconfigPath: KUBECONFIG_PATH },
      {}
    );
    expect(kubeConfig.getCurrentContext()).toBe("orbstack");
  });

  it("throws when kubeContext names a context absent from the kubeconfig", () => {
    expect(() =>
      resolveKubeConfig(
        { kubeContext: "does-not-exist", kubeconfigPath: KUBECONFIG_PATH },
        {}
      )
    ).toThrow();
  });
});
