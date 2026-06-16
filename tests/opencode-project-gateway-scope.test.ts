import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../src/config/schemas";
import { shouldEmbedProjectGateway } from "../src/install-commands/opencode";

// PIPE-83.11: the singleton pipeline gateway can be registered once globally and
// inherited, instead of being synthesized into every repo's opencode config.
const gateway = {
  backends: {},
  authorization_env: "PIPELINE_MCP_GATEWAY_AUTHORIZATION",
  mode: "hosted" as const,
  provider: "toolhive" as const,
  url: "https://pipeline-mcp.example/mcp/",
  url_env: "PIPELINE_MCP_GATEWAY_URL",
};

function configWith(
  mcp_gateway: Record<string, unknown> | undefined
): PipelineConfig {
  return { mcp_gateway } as unknown as PipelineConfig;
}

describe("shouldEmbedProjectGateway", () => {
  it("embeds the gateway when host_scope is project (the default)", () => {
    expect(
      shouldEmbedProjectGateway(
        configWith({ ...gateway, host_scope: "project" })
      )
    ).toBe(true);
  });

  it("omits the gateway when host_scope is global", () => {
    expect(
      shouldEmbedProjectGateway(
        configWith({ ...gateway, host_scope: "global" })
      )
    ).toBe(false);
  });

  it("does not embed a gateway that is not configured", () => {
    expect(shouldEmbedProjectGateway(configWith(undefined))).toBe(false);
  });
});
