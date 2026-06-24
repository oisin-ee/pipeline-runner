import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncLocalCodexAuth } from "../src/codex-auth-sync";

describe("syncLocalCodexAuth", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipeline-codex-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses one global oc-codex account pool and adds project plugin entries", () => {
    const globalConfigPath = join(
      dir,
      "home/.opencode/openai-codex-auth-config.json"
    );
    mkdirSync(join(dir, "home/.opencode"), { recursive: true });
    writeFileSync(
      globalConfigPath,
      `${JSON.stringify({ retryProfile: "conservative", perProjectAccounts: true }, null, 2)}\n`
    );
    const repo = gitRepo("app");
    mkdirSync(join(repo, ".opencode"), { recursive: true });
    writeFileSync(
      join(repo, ".opencode/opencode.json"),
      JSON.stringify(
        {
          mcp: { "pipeline-gateway": { url: "https://example.test/mcp" } },
          plugin: ["local-plugin"],
        },
        null,
        2
      )
    );

    const result = syncLocalCodexAuth({
      broker: null,
      globalConfigPath,
      root: dir,
    });

    expect(result.items.map((item) => [item.action, item.path])).toEqual([
      ["update", globalConfigPath],
      ["update", join(repo, ".opencode/opencode.json")],
    ]);
    expect(JSON.parse(readFileSync(globalConfigPath, "utf8"))).toEqual({
      retryProfile: "conservative",
      perProjectAccounts: false,
    });
    const projectConfig = JSON.parse(
      readFileSync(join(repo, ".opencode/opencode.json"), "utf8")
    );
    expect(projectConfig.mcp["pipeline-gateway"]).toEqual({
      url: "https://example.test/mcp",
    });
    expect(projectConfig.plugin).toEqual([
      "local-plugin",
      "oc-codex-multi-auth@6.3.2",
    ]);
  });

  it("creates missing project config and repairs JSONC trailing comma configs", () => {
    const globalConfigPath = join(
      dir,
      "home/.opencode/openai-codex-auth-config.json"
    );
    const missing = gitRepo("missing");
    const jsonc = gitRepo("jsonc");
    mkdirSync(join(jsonc, ".opencode"), { recursive: true });
    writeFileSync(
      join(jsonc, ".opencode/opencode.json"),
      [
        "{",
        '  "plugin": [',
        '    "@prevalentware/opencode-goal-plugin",',
        "  ]",
        "}",
      ].join("\n")
    );

    syncLocalCodexAuth({ broker: null, globalConfigPath, root: dir });

    expect(existsSync(join(missing, ".opencode/opencode.json"))).toBe(true);
    expect(
      parse(readFileSync(join(missing, ".opencode/opencode.json"), "utf8"))
        .plugin
    ).toEqual(["oc-codex-multi-auth@6.3.2"]);
    expect(
      JSON.parse(readFileSync(join(jsonc, ".opencode/opencode.json"), "utf8"))
        .plugin
    ).toEqual([
      "@prevalentware/opencode-goal-plugin",
      "oc-codex-multi-auth@6.3.2",
    ]);
  });

  it("reports required changes in check mode without writing", () => {
    const globalConfigPath = join(
      dir,
      "home/.opencode/openai-codex-auth-config.json"
    );
    const repo = gitRepo("app");

    const result = syncLocalCodexAuth({
      broker: null,
      check: true,
      globalConfigPath,
      root: dir,
    });

    expect(result.ok).toBe(false);
    expect(result.items.every((item) => item.action === "create")).toBe(true);
    expect(existsSync(globalConfigPath)).toBe(false);
    expect(existsSync(join(repo, ".opencode/opencode.json"))).toBe(false);
  });

  it("broker mode: sets opencode openai baseURL per repo and never declares the multi-auth plugin", () => {
    const globalConfigPath = join(
      dir,
      "home/.opencode/openai-codex-auth-config.json"
    );
    const repo = gitRepo("app");
    mkdirSync(join(repo, ".opencode"), { recursive: true });
    writeFileSync(
      join(repo, ".opencode/opencode.json"),
      JSON.stringify(
        { model: "openai/gpt-5.5-medium", plugin: ["local-plugin"] },
        null,
        2
      )
    );

    const result = syncLocalCodexAuth({
      broker: { apiKey: "sk-maa-test", baseUrl: "https://broker.test" },
      globalConfigPath,
      root: dir,
    });

    // No global multi-auth pool config is touched in broker mode.
    expect(result.items.map((item) => item.path)).toEqual([
      join(repo, ".opencode/opencode.json"),
    ]);
    expect(existsSync(globalConfigPath)).toBe(false);

    const projectConfig = JSON.parse(
      readFileSync(join(repo, ".opencode/opencode.json"), "utf8")
    );
    expect(projectConfig.provider.openai.options.baseURL).toBe(
      "https://broker.test/v1"
    );
    expect(projectConfig.plugin).toEqual(["local-plugin"]);
    expect(JSON.stringify(projectConfig)).not.toContain("oc-codex-multi-auth");
  });

  function gitRepo(name: string): string {
    const repo = join(dir, name);
    mkdirSync(join(repo, ".git"), { recursive: true });
    return repo;
  }
});
