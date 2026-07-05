import { describe, expect, it } from "vitest";

import { brokerV1Url, resolveBrokerCredentials } from "./broker";
import type { BrokerCredentials } from "./broker";
import { applyCodexBrokerProvider } from "./codex-config";
import {
  applyOpencodeBrokerProvider,
  renderOpencodeBrokerAuthJson,
} from "./opencode-config";

const CREDS: BrokerCredentials = {
  apiKey: "sk-maa-test",
  baseUrl: "https://broker.test",
};

describe("resolveBrokerCredentials", () => {
  it("returns undefined when BROKER_API_KEY is absent or empty", () => {
    expect(resolveBrokerCredentials({})).toBeUndefined();
    expect(resolveBrokerCredentials({ BROKER_API_KEY: "" })).toBeUndefined();
  });

  it("defaults the broker URL to the production origin", () => {
    expect(resolveBrokerCredentials({ BROKER_API_KEY: "k" })).toEqual({
      apiKey: "k",
      baseUrl: "https://cliproxy.momokaya.ee",
    });
  });

  it("honors BROKER_URL and strips trailing slashes", () => {
    expect(
      resolveBrokerCredentials({
        BROKER_API_KEY: "k",
        BROKER_URL: "https://x.test/",
      })
    ).toEqual({ apiKey: "k", baseUrl: "https://x.test" });
  });
});

describe("brokerV1Url", () => {
  it("appends /v1 to the broker origin", () => {
    expect(brokerV1Url(CREDS)).toBe("https://broker.test/v1");
  });
});

describe("renderOpencodeBrokerAuthJson", () => {
  it("writes the api-key under the openai provider", () => {
    expect(JSON.parse(renderOpencodeBrokerAuthJson(CREDS))).toEqual({
      openai: { key: "sk-maa-test", type: "api" },
    });
  });
});

describe("applyCodexBrokerProvider", () => {
  it("injects the broker provider, preserving existing config", () => {
    const out = applyCodexBrokerProvider(
      ['model = "gpt-5.5"', "", "[features]", "hooks = true"].join("\n"),
      CREDS
    );
    expect(out).toContain('model = "gpt-5.5"');
    expect(out).toContain("[features]");
    expect(out).toContain('model_provider = "broker"');
    expect(out).toContain("[model_providers.broker]");
    expect(out).toContain('base_url = "https://broker.test/v1"');
    expect(out).toContain('env_key = "BROKER_API_KEY"');
    expect(out).toContain('wire_api = "responses"');
  });

  it("is idempotent (no duplicate provider blocks on re-run)", () => {
    const once = applyCodexBrokerProvider('model = "gpt-5.5"', CREDS);
    const twice = applyCodexBrokerProvider(once, CREDS);
    expect(twice).toBe(once);
    expect(twice.match(/\[model_providers\.broker\]/gu)).toHaveLength(1);
    expect(twice.match(/model_provider = "broker"/gu)).toHaveLength(1);
  });

  it("creates a config from empty input", () => {
    const out = applyCodexBrokerProvider(undefined, CREDS);
    expect(out).toContain('model_provider = "broker"');
  });
});

describe("applyOpencodeBrokerProvider", () => {
  it("creates a minimal config pointing the openai provider at the broker", () => {
    const result = applyOpencodeBrokerProvider(undefined, CREDS);
    expect("content" in result).toBe(true);
    if ("error" in result) {
      throw new Error(result.error);
    }
    const parsed = JSON.parse(result.content);
    expect(parsed.provider.openai.options).toEqual({
      baseURL: "https://broker.test/v1",
      include: ["reasoning.encrypted_content"],
      store: false,
    });
  });

  it("drops the multi-auth plugin and preserves other config", () => {
    const result = applyOpencodeBrokerProvider(
      JSON.stringify({
        model: "openai/gpt-5.5-medium",
        plugin: ["keep-me", ["oc-codex-multi-auth@6.3.2", {}]],
        provider: { openai: { options: { textVerbosity: "medium" } } },
      }),
      CREDS
    );
    if ("error" in result) {
      throw new Error(result.error);
    }
    const parsed = JSON.parse(result.content);
    expect(parsed.plugin).toEqual(["keep-me"]);
    expect(parsed.model).toBe("openai/gpt-5.5-medium");
    expect(parsed.provider.openai.options).toEqual({
      baseURL: "https://broker.test/v1",
      include: ["reasoning.encrypted_content"],
      store: false,
      textVerbosity: "medium",
    });
  });

  it("returns an error for malformed JSON", () => {
    const result = applyOpencodeBrokerProvider("{not json", CREDS);
    expect("error" in result).toBe(true);
  });
});
