import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpencodeCredentials } from "./opencode-accounts";

const BROKER_REQUIRED_RE = /BROKER_API_KEY is required/;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-creds-"));
  tempDirs.push(dir);
  return dir;
}

describe("prepareOpencodeCredentials", () => {
  it("writes broker auth + codex provider + opencode baseURL and drops the legacy multi-auth plugin", () => {
    const fixture = tempDir();
    const codexConfigPath = join(fixture, "home", ".codex", "config.toml");
    const opencodeAuthPath = join(
      fixture,
      "home",
      ".local",
      "share",
      "opencode",
      "auth.json"
    );
    const opencodeConfigPath = join(
      fixture,
      "home",
      ".config",
      "opencode",
      "opencode.json"
    );
    // Seed an existing codex config + opencode config carrying the legacy
    // multi-auth plugin, to prove broker mode injects the provider and drops it.
    mkdirSync(dirname(codexConfigPath), { recursive: true });
    writeFileSync(
      codexConfigPath,
      ['model = "gpt-5.5"', "", "[features]", "hooks = true", ""].join("\n")
    );
    mkdirSync(dirname(opencodeConfigPath), { recursive: true });
    writeFileSync(
      opencodeConfigPath,
      `${JSON.stringify(
        {
          model: "openai/gpt-5.5-medium",
          plugin: [
            "@prevalentware/opencode-goal-plugin",
            "oc-codex-multi-auth@6.3.2",
          ],
        },
        null,
        2
      )}\n`
    );

    const result = prepareOpencodeCredentials({
      broker: { apiKey: "sk-maa-test", baseUrl: "https://broker.test" },
      brokerPaths: { codexConfigPath, opencodeAuthPath, opencodeConfigPath },
    });

    expect(result.brokerConfigured.sort()).toEqual(
      ["auth.json", "config.toml", "opencode.json"].sort()
    );

    // opencode auth.json: broker api-key.
    expect(JSON.parse(readFileSync(opencodeAuthPath, "utf8"))).toEqual({
      openai: { key: "sk-maa-test", type: "api" },
    });

    // codex config.toml: broker provider injected, existing config preserved.
    const codexConfig = readFileSync(codexConfigPath, "utf8");
    expect(codexConfig).toContain('model = "gpt-5.5"');
    expect(codexConfig).toContain('model_provider = "broker"');
    expect(codexConfig).toContain("[model_providers.broker]");
    expect(codexConfig).toContain('base_url = "https://broker.test/v1"');
    expect(codexConfig).toContain('env_key = "BROKER_API_KEY"');
    expect(codexConfig).toContain('wire_api = "responses"');

    // opencode config: openai baseURL set, multi-auth plugin dropped, other
    // plugin + model preserved.
    const opencodeConfig = JSON.parse(readFileSync(opencodeConfigPath, "utf8"));
    expect(opencodeConfig.provider.openai.options.baseURL).toBe(
      "https://broker.test/v1"
    );
    expect(opencodeConfig.provider.openai.options.store).toBe(false);
    expect(opencodeConfig.plugin).toEqual([
      "@prevalentware/opencode-goal-plugin",
    ]);
    expect(opencodeConfig.model).toBe("openai/gpt-5.5-medium");
  });

  it("throws when BROKER_API_KEY is absent (no bespoke auth path remains)", () => {
    const previous = process.env.BROKER_API_KEY;
    delete process.env.BROKER_API_KEY;
    try {
      expect(() => prepareOpencodeCredentials()).toThrow(BROKER_REQUIRED_RE);
    } finally {
      if (previous !== undefined) {
        process.env.BROKER_API_KEY = previous;
      }
    }
  });
});
