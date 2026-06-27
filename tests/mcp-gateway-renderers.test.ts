import { describe, expect, it } from "vitest";
import {
  type PipelineConfigParts,
  parsePipelineConfigParts,
} from "../src/config";
import {
  gatewayServerForProfile,
  renderGatewayConfig,
} from "../src/mcp/gateway-config";
import {
  renderClaudeGatewayUserConfig,
  renderCodexGatewayConfig,
  renderOpenCodeGatewayConfig,
} from "../src/mcp/host-renderers";

const PARTS: PipelineConfigParts = {
  pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes: []
`,
  profiles: `
version: 1
mcp_gateway:
  provider: toolhive
  mode: hosted
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
  backends: {}
profiles:
  orchestrator:
    runner: opencode
    instructions: { inline: "Run." }
    mcp_servers: [pipeline-gateway]
    tools: [read]
    filesystem: { mode: read-only }
    network: { mode: inherit }
`,
  runners: `
version: 1
runners:
  opencode:
    type: opencode
    capabilities:
      mcp_servers: true
      tools: [read]
      filesystem: [read-only]
      network: [inherit]
      output_formats: [text]
`,
};

const ENV: NodeJS.ProcessEnv = {
  PIPELINE_MCP_GATEWAY_URL: "https://gateway.example/mcp",
};
const CLAUDE_GATEWAY_AUTH_HEADER = [
  "$",
  "{PIPELINE_MCP_GATEWAY_AUTHORIZATION}",
].join("");

describe("MCP gateway pure renderers", () => {
  it("renders host gateway configs without filesystem or process IO", () => {
    const config = parsePipelineConfigParts(PARTS);

    const opencode = JSON.parse(renderOpenCodeGatewayConfig(config, ENV));
    expect(opencode.mcp["pipeline-gateway"]).toEqual({
      enabled: true,
      headers: {
        Authorization: "{env:PIPELINE_MCP_GATEWAY_AUTHORIZATION}",
      },
      oauth: false,
      type: "remote",
      url: "https://gateway.example/mcp",
    });

    const claude = JSON.parse(renderClaudeGatewayUserConfig(config, ENV));
    expect(claude.mcpServers["pipeline-gateway"]).toEqual({
      headers: {
        Authorization: CLAUDE_GATEWAY_AUTH_HEADER,
      },
      type: "http",
      url: "https://gateway.example/mcp",
    });

    expect(renderCodexGatewayConfig(config, ENV)).toContain(
      'url = "https://gateway.example/mcp"'
    );
  });

  it("renders profile gateway grants through the same config resolution", () => {
    const config = parsePipelineConfigParts(PARTS);
    const profile = config.profiles.orchestrator;

    expect(gatewayServerForProfile(config, profile, ENV)).toEqual({
      "pipeline-gateway": {
        headers: {
          Authorization: "{env:PIPELINE_MCP_GATEWAY_AUTHORIZATION}",
        },
        url: "https://gateway.example/mcp",
      },
    });
    expect(renderGatewayConfig(config, ENV)).toContain(
      "resolved_url: https://gateway.example/mcp"
    );
  });
});
