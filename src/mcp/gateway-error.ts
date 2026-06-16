import { Data } from "effect";

/**
 * Tagged error for the MCP (ToolHive) gateway subsystem. Lives in its own module
 * so both the gateway facade (src/mcp/gateway.ts) and the Effect service
 * (src/runtime/services/mcp-gateway-service.ts) can import it without forming a
 * circular dependency between them.
 */
export class PipelineMcpGatewayError extends Data.TaggedError(
  "PipelineMcpGatewayError"
)<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
