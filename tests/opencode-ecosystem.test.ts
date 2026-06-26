import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST,
  OPENCODE_ECOSYSTEM_MANIFEST_PATH,
  parseOpenCodeEcosystemManifest,
} from "../src/config";

describe("OpenCode ecosystem manifest", () => {
  it("loads the package-owned curated default stack", () => {
    const manifest = DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST;

    expect(manifest.version).toBe(1);
    expect(manifest.runtime).toMatchObject({
      default_runner: "opencode",
      compatibility_runners: [],
      default_stack_direct: true,
      state_authority: "pipeline",
    });
    expect(manifest.official_dependencies.map((item) => item.id)).toEqual([
      "@opencode-ai/plugin",
      "@opencode-ai/sdk",
    ]);
    expect(
      manifest.official_dependencies.map((item) => item.dependency_scope)
    ).toEqual(["package-code-when-needed", "package-code-when-needed"]);

    expect(manifest.ecosystem_code.map((item) => item.id)).toEqual([
      "pipeline-goal-context",
      "dcp-code",
      "opencode-background-agents",
      "opencode-handoff",
      "opencode-plugin-otel",
      "opencode-goal-plugin",
      "opencode-snip",
      "opencode-mem",
      "cupcake",
    ]);
    expect(manifest.ecosystem_code.every((item) => item.default_stack)).toBe(
      true
    );
    expect(
      manifest.ecosystem_code.find((item) => item.id === "dcp-code")
    ).toEqual(expect.objectContaining({ name: "DCP code" }));
    expect(
      manifest.ecosystem_code.find(
        (item) => item.id === "pipeline-goal-context"
      )
    ).toEqual(
      expect.objectContaining({
        plugin: expect.objectContaining({
          kind: "local",
          target_path: ".opencode/plugins/pipeline-goal-context.ts",
        }),
      })
    );
    expect(
      manifest.ecosystem_code.find((item) => item.id === "opencode-plugin-otel")
    ).toEqual(
      expect.objectContaining({
        plugin: expect.objectContaining({
          kind: "npm",
          package: "@devtheops/opencode-plugin-otel@1.1.0",
        }),
      })
    );
  });

  it("surfaces pipeline MCP backends, skills, prompts, and host capabilities", () => {
    const manifest = DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST;

    expect(manifest.mcp_backends.map((backend) => backend.id)).toEqual([
      "pipeline-gateway",
      "context7",
      "uidotsh",
      "qdrant",
      "fallow",
      "serena",
      "backlog",
      "github",
      "playwright",
      "neon",
    ]);
    expect(
      manifest.mcp_backends.find((backend) => backend.id === "pipeline-gateway")
    ).toEqual(
      expect.objectContaining({
        credentials: ["PIPELINE_MCP_GATEWAY_AUTHORIZATION"],
        required: true,
      })
    );
    expect(manifest.skills.map((skill) => skill.id)).toEqual([
      "pipe",
      "inspect",
      "epic",
      "execute",
      "research",
      "library-first-development",
      "critique",
      "verify",
    ]);
    expect(manifest.prompts.map((prompt) => prompt.id)).toEqual([
      "orchestrator",
      "researcher",
      "inspector",
      "schedule-planner",
      "test-writer",
      "code-writer",
      "acceptance-reviewer",
      "verifier",
    ]);
    expect(manifest.host_capabilities).toEqual({
      agents: true,
      commands: true,
      lsp: true,
      mcp_servers: true,
      permissions: true,
      plugins: true,
      project_config: true,
      skills: true,
      subagents: true,
    });
  });

  it("parses the checked-in manifest through the exported schema", () => {
    const source = readFileSync(OPENCODE_ECOSYSTEM_MANIFEST_PATH, "utf8");

    expect(parseOpenCodeEcosystemManifest(source)).toEqual(
      DEFAULT_OPENCODE_ECOSYSTEM_MANIFEST
    );
  });
});
