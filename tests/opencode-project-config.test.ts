import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { mergeOpenCodeProjectConfig } from "../src/opencode-project-config";

const projection = {
  $schema: "https://opencode.ai/config.json",
  lsp: true,
  mcp: {
    "pipeline-gateway": {
      enabled: true,
      headers: {
        Authorization: "{env:PIPELINE_MCP_GATEWAY_AUTHORIZATION}",
      },
      oauth: false,
      type: "remote",
      url: "https://pipeline-mcp.momokaya.ee/mcp/",
    },
  },
  plugin: [
    "@devtheops/opencode-plugin-otel@1.1.0",
    "@prevalentware/opencode-goal-plugin",
    "oc-codex-multi-auth",
  ],
};

describe("mergeOpenCodeProjectConfig", () => {
  it("preserves local plugin entries and appends package defaults", () => {
    const result = mergeOpenCodeProjectConfig(
      JSON.stringify(
        {
          plugin: ["local-auth-plugin", ["tuple-plugin", { enabled: true }]],
        },
        null,
        2
      ),
      projection
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const merged = JSON.parse(result.content);
    expect(merged.plugin).toEqual([
      "local-auth-plugin",
      ["tuple-plugin", { enabled: true }],
      "@devtheops/opencode-plugin-otel@1.1.0",
      "@prevalentware/opencode-goal-plugin",
      "oc-codex-multi-auth",
    ]);
  });

  it("preserves an existing pipeline-gateway entry exactly", () => {
    const existingGateway = {
      enabled: true,
      headers: { Authorization: "{env:CUSTOM_GATEWAY_TOKEN}" },
      oauth: false,
      timeout: 30_000,
      type: "remote",
      url: "https://custom.example/mcp",
    };
    const result = mergeOpenCodeProjectConfig(
      JSON.stringify({ mcp: { "pipeline-gateway": existingGateway } }, null, 2),
      projection
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const merged = JSON.parse(result.content);
    expect(merged.mcp["pipeline-gateway"]).toEqual(existingGateway);
  });

  it("adds gateway, schema, and lsp only when missing", () => {
    const result = mergeOpenCodeProjectConfig(
      '{\n  // user config\n  "lsp": false,\n  "plugin": ["oc-codex-multi-auth"],\n}\n',
      projection
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const merged = parse(result.content);
    expect(merged.$schema).toBe("https://opencode.ai/config.json");
    expect(merged.lsp).toBe(false);
    expect(merged.mcp["pipeline-gateway"]).toEqual(
      projection.mcp["pipeline-gateway"]
    );
    expect(
      merged.plugin.filter((item: string) => item === "oc-codex-multi-auth")
    ).toHaveLength(1);
  });

  it("returns a conflict for invalid JSONC", () => {
    const result = mergeOpenCodeProjectConfig('{ "plugin": [', projection);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
