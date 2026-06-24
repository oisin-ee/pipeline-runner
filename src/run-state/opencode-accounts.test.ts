import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// dirname + mkdirSync + writeFileSync are used by the broker-mode test below.
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpencodeCredentials } from "./opencode-accounts";

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

function stage(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o400); // the real secret mount is read-only
}

const ACCOUNTS_DEST_NAME = "oc-codex-multi-auth-accounts.json";

describe("prepareOpencodeCredentials", () => {
  it("copies staged files writable and syncs the fresh openai token into auth.json", () => {
    const fixture = tempDir();
    const accountsStaged = join(fixture, "staged-accounts", "accounts.json");
    const authStaged = join(fixture, "staged-auth", "auth.json");
    const accountsDest = join(fixture, "home", ".opencode", ACCOUNTS_DEST_NAME);
    const authDest = join(
      fixture,
      "home",
      ".local",
      "share",
      "opencode",
      "auth.json"
    );
    // Pool has a FRESH token at the active index; auth.json has a STALE openai
    // token (the exact shape that caused the 401: plugin skips backfill of an
    // existing-but-expired entry).
    stage(
      accountsStaged,
      JSON.stringify({
        accounts: [
          {
            accessToken: "fresh-access",
            expiresAt: 9999,
            refreshToken: "fresh-refresh",
          },
        ],
        activeIndex: 0,
        activeIndexByFamily: { codex: 0 },
      })
    );
    stage(
      authStaged,
      JSON.stringify({
        anthropic: { type: "api", key: "keep-me" },
        openai: {
          access: "stale-access",
          expires: 1,
          refresh: "stale-refresh",
          type: "oauth",
        },
      })
    );

    const result = prepareOpencodeCredentials({
      broker: null,
      files: [
        { destPath: accountsDest, stagedPath: accountsStaged },
        { destPath: authDest, stagedPath: authStaged },
      ],
    });

    expect(result.copied.sort()).toEqual(
      [ACCOUNTS_DEST_NAME, "auth.json"].sort()
    );
    expect(result.hostOpenaiTokenSynced).toBe(true);
    const auth = JSON.parse(readFileSync(authDest, "utf8"));
    // openai token replaced with the pool's fresh token...
    expect(auth.openai).toEqual({
      access: "fresh-access",
      expires: 9999,
      refresh: "fresh-refresh",
      type: "oauth",
    });
    // ...other providers preserved.
    expect(auth.anthropic).toEqual({ type: "api", key: "keep-me" });
    // Both writable so the plugin's atomic rewrite succeeds.
    expect(() => accessSync(accountsDest, constants.W_OK)).not.toThrow();
    expect(() => accessSync(authDest, constants.W_OK)).not.toThrow();
  });

  it("copies only the files whose staged source exists", () => {
    const fixture = tempDir();
    const authStaged = join(fixture, "staged-auth", "auth.json");
    const authDest = join(
      fixture,
      "home",
      ".local",
      "share",
      "opencode",
      "auth.json"
    );
    stage(authStaged, '{"openai":{"type":"oauth"}}\n');

    const result = prepareOpencodeCredentials({
      broker: null,
      files: [
        {
          destPath: join(fixture, "home", ".opencode", "accounts.json"),
          stagedPath: join(fixture, "absent", "accounts.json"),
        },
        { destPath: authDest, stagedPath: authStaged },
      ],
    });

    expect(result.copied).toEqual(["auth.json"]);
  });

  it("is a no-op when no staged secret is mounted (local dev, tests)", () => {
    const fixture = tempDir();
    const result = prepareOpencodeCredentials({
      broker: null,
      files: [
        {
          destPath: join(fixture, ".opencode", "accounts.json"),
          stagedPath: join(fixture, "absent", "accounts.json"),
        },
      ],
    });

    expect(result.copied).toEqual([]);
  });

  it("broker mode: writes broker auth + codex provider + opencode baseURL and skips pool staging", () => {
    const fixture = tempDir();
    const accountsStaged = join(fixture, "staged-accounts", "accounts.json");
    stage(accountsStaged, JSON.stringify({ accounts: [], activeIndex: 0 }));
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
      // A staged pool is present, but broker mode must NOT copy it.
      files: [
        {
          destPath: join(fixture, "home", ".opencode", ACCOUNTS_DEST_NAME),
          stagedPath: accountsStaged,
        },
      ],
    });

    expect(result.copied).toEqual([]);
    expect(result.hostOpenaiTokenSynced).toBe(false);
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
});
