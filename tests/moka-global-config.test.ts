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
    brokerAuth:
      secretName: broker-api-key
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
      brokerAuth: {
        secretKey: "api-key",
        secretName: "broker-api-key",
        url: "https://cliproxy.momokaya.ee",
      },
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

  describe("momokaya.db (PIPE-91.3)", () => {
    const CONFIG_WITH_DB_URL = `
momokaya:
  kubernetes:
    kubeconfig: /path/to/cluster.kubeconfig
    namespace: pipeline-namespace
  submit:
    brokerAuth:
      secretName: broker-api-key
    eventAuthSecretKey: EVENT_AUTH_TOKEN_KEY
    eventAuthSecretName: event-auth-secret
    eventUrl: https://console.example.test/api/pipeline/runner-events
    gitCredentialsSecretName: git-credentials-secret
    githubAuthSecretName: github-auth-secret
    imagePullSecretName: image-pull-secret
    serviceAccountName: runner-service-account
  db:
    url: postgres://localhost:5432/pipeline
`;

    it("accepts a valid postgres db.url", () => {
      const config = parseMokaGlobalConfig(
        CONFIG_WITH_DB_URL,
        "/Users/oisin/.config/moka/config.yaml"
      );
      expect(config.momokaya.db?.url).toBe(
        "postgres://localhost:5432/pipeline"
      );
    });

    it("accepts a valid postgresql:// db.url", () => {
      const config = parseMokaGlobalConfig(
        CONFIG_WITH_DB_URL.replace(
          "postgres://localhost:5432/pipeline",
          "postgresql://db.example.com:5432/pipeline"
        ),
        "/Users/oisin/.config/moka/config.yaml"
      );
      expect(config.momokaya.db?.url).toBe(
        "postgresql://db.example.com:5432/pipeline"
      );
    });

    it("parses correctly when db block is absent (presence semantics — absence = in-memory)", () => {
      const config = parseMokaGlobalConfig(
        VALID_CONFIG,
        "/Users/oisin/.config/moka/config.yaml"
      );
      expect(config.momokaya.db).toBeUndefined();
    });

    it("rejects a non-URL db.url value", () => {
      expect(() =>
        parseMokaGlobalConfig(
          CONFIG_WITH_DB_URL.replace(
            "postgres://localhost:5432/pipeline",
            "not-a-url"
          ),
          "/Users/oisin/.config/moka/config.yaml"
        )
      ).toThrow("Invalid /Users/oisin/.config/moka/config.yaml");
    });

    it("rejects an http db.url (must use postgresql or postgres protocol)", () => {
      expect(() =>
        parseMokaGlobalConfig(
          CONFIG_WITH_DB_URL.replace(
            "postgres://localhost:5432/pipeline",
            "http://localhost:5432/pipeline"
          ),
          "/Users/oisin/.config/moka/config.yaml"
        )
      ).toThrow("postgresql or postgres protocol");
    });
  });
});
