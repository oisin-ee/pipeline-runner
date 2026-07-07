import { Effect } from "effect";

import { McpGatewayServiceLive } from "../runtime/services/mcp-gateway-service";
import type { McpGatewayService } from "../runtime/services/mcp-gateway-service";
import type { PipelineMcpGatewayError } from "./gateway-error";

export const runMcpGatewayEffect = async <A>(
  program: Effect.Effect<A, PipelineMcpGatewayError, McpGatewayService>
): Promise<A> =>
  await Effect.runPromise(Effect.provide(program, McpGatewayServiceLive));
