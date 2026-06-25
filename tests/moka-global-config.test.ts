import { describe, expect, it } from "vitest";
import {
  MOKA_GLOBAL_CONFIG_PATH,
  mokaGlobalConfigPath,
  parseMokaGlobalConfig,
} from "../src/moka-global-config";

const VALID_CONFIG = `
momokaya:
  kubernetes:
    kubeconfig: /path/to/cluster.kubeconfig
    namespace: pipeline-namespace
  submit:
    eventAuthSecretKey: EVENT_AUTH_TOKEN_KEY
    eventAuthSecretName: event-auth-secret
    eventUrl: https://console.example.test/api/pipeline/runner-events
    gitCredentialsSecretName: git-credentials-secret
    githubAuthSecretName: github-auth-secret
    imagePullSecretName: image-pull-secret
    serviceAccountName: runner-service-account
`;

describe("moka global config", () => {
  it("uses the fixed user config path", () => {
    expect(MOKA_GLOBAL_CONFIG_PATH).toBe(".config/moka/config.yaml");
    expect(mokaGlobalConfigPath("/Users/example")).toBe(
      "/Users/example/.config/moka/config.yaml"
    );
  });

  it("parses the private Momokaya submit target", () => {
    const config = parseMokaGlobalConfig(
      VALID_CONFIG,
      "/Users/oisin/.config/moka/config.yaml"
    );

    expect(config.momokaya.kubernetes).toEqual({
      kubeconfig: "/path/to/cluster.kubeconfig",
      namespace: "pipeline-namespace",
    });
    expect(config.momokaya.submit).toMatchObject({
      eventUrl: "https://console.example.test/api/pipeline/runner-events",
      serviceAccountName: "runner-service-account",
    });
  });

  it("rejects incomplete config", () => {
    expect(() =>
      parseMokaGlobalConfig(
        "momokaya:\n  kubernetes:\n    namespace: pipeline-namespace\n  submit: {}\n",
        "/Users/oisin/.config/moka/config.yaml"
      )
    ).toThrow("Invalid /Users/oisin/.config/moka/config.yaml");
  });
});
