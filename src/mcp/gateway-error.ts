import { Data } from "effect";

/**
 * Tagged error for the MCP (ToolHive) gateway subsystem. Lives in its own module
 * so MCP command modules and the Effect service can share one error type without
 * forming circular dependencies.
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
