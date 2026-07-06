import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatCodexAuthSyncResult, syncLocalCodexAuth } from "../src/credentials/local-codex-auth-sync";

const BROKER_REQUIRED_RE = /BROKER_API_KEY is required/u;

describe("syncLocalCodexAuth", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pipeline-codex-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("fails when BROKER_API_KEY is absent (no bespoke multi-auth path remains)", () => {
    const previous = process.env.BROKER_API_KEY;
    delete process.env.BROKER_API_KEY;
    try {
      const result = syncLocalCodexAuth({ root: dir });
      expect(result.ok).toBe(false);
      expect(result.items[0]?.action).toBe("error");
      expect(result.items[0]?.message).toMatch(BROKER_REQUIRED_RE);
    } finally {
      if (previous !== undefined) {
        process.env.BROKER_API_KEY = previous;
      }
    }
  });

  const gitRepo = (name: string): string => {
    const repo = join(dir, name);
    mkdirSync(join(repo, ".git"), { recursive: true });
    return repo;
  };

  it("points each repo's opencode openai provider at the broker and never declares the multi-auth plugin", () => {
    const repo = gitRepo("app");
    mkdirSync(join(repo, ".opencode"), { recursive: true });
    writeFileSync(
      join(repo, ".opencode/opencode.json"),
      JSON.stringify({ model: "openai/gpt-5.5-medium", plugin: ["local-plugin"] }, null, 2),
    );

    const result = syncLocalCodexAuth({
      broker: { apiKey: "sk-maa-test", baseUrl: "https://broker.test" },
      root: dir,
    });

    expect(result.items.map((item) => item.path)).toEqual([join(repo, ".opencode/opencode.json")]);

    const projectConfig = JSON.parse(readFileSync(join(repo, ".opencode/opencode.json"), "utf-8"));
    expect(projectConfig.provider.openai.options.baseURL).toBe("https://broker.test/v1");
    expect(projectConfig.plugin).toEqual(["local-plugin"]);
    expect(JSON.stringify(projectConfig)).not.toContain("oc-codex-multi-auth");
  });

  it("creates a missing project config pointing at the broker", () => {
    const repo = gitRepo("missing");

    syncLocalCodexAuth({
      broker: { apiKey: "sk-maa-test", baseUrl: "https://broker.test" },
      root: dir,
    });

    const projectConfig = JSON.parse(readFileSync(join(repo, ".opencode/opencode.json"), "utf-8"));
    expect(projectConfig.provider.openai.options.baseURL).toBe("https://broker.test/v1");
    expect(JSON.stringify(projectConfig)).not.toContain("oc-codex-multi-auth");
  });

  it("reports required changes in check mode without writing", () => {
    const repo = gitRepo("app");

    const result = syncLocalCodexAuth({
      broker: { apiKey: "sk-maa-test", baseUrl: "https://broker.test" },
      check: true,
      root: dir,
    });

    expect(result.ok).toBe(false);
    expect(result.items.every((item) => item.action === "create")).toBe(true);
    expect(existsSync(join(repo, ".opencode/opencode.json"))).toBe(false);
  });

  it("reports sync actions without exposing the broker api-key", () => {
    gitRepo("app");

    const result = syncLocalCodexAuth({
      broker: {
        apiKey: "sk-maa-secret",
        baseUrl: "https://broker.test",
      },
      check: true,
      root: dir,
    });

    expect(formatCodexAuthSyncResult(result)).not.toContain("sk-maa-secret");
  });
});
