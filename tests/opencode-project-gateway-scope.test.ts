import { describe, expect, it } from "vitest";

import type { PipelineConfig } from "../src/config/schemas";
import { shouldEmbedProjectGateway } from "../src/install-commands/opencode";

// PIPE-83.11: the singleton pipeline gateway can be registered once globally and
// inherited, instead of being synthesized into every repo's opencode config.
const gateway = {
  authorization_env: "PIPELINE_MCP_GATEWAY_AUTHORIZATION",
  backends: {},
  mode: "hosted" as const,
  provider: "toolhive" as const,
  url: "https://pipeline-mcp.example/mcp/",
  url_env: "PIPELINE_MCP_GATEWAY_URL",
};

const configWith = (mcp_gateway?: Record<string, unknown>): PipelineConfig =>
  ({ mcp_gateway }) as unknown as PipelineConfig;

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
    expect(shouldEmbedProjectGateway(configWith())).toBe(false);
  });
});
