import { Effect } from "effect";
import {
  type McpGatewayService,
  McpGatewayServiceLive,
} from "../runtime/services/mcp-gateway-service";
import type { PipelineMcpGatewayError } from "./gateway-error";

export function runMcpGatewayEffect<A>(
  program: Effect.Effect<A, PipelineMcpGatewayError, McpGatewayService>
): Promise<A> {
  return Effect.runPromise(Effect.provide(program, McpGatewayServiceLive));
}
