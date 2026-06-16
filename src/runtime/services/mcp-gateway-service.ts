import { Context, Effect, Layer } from "effect";
import { execa } from "execa";
import { PipelineMcpGatewayError } from "../../mcp/gateway-error";
import type { ToolHiveWorkload } from "../../mcp/toolhive-vmcp";

interface ToolHiveListWorkload {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly transport?: unknown;
  readonly transport_type?: unknown;
  readonly url?: unknown;
}

interface GatewayRpcResponse {
  readonly result?: { readonly tools?: unknown };
}

function gatewayError(message: string): PipelineMcpGatewayError {
  return new PipelineMcpGatewayError(message);
}

function execaErrorMessage(error: unknown): string {
  const subprocessError = error as { shortMessage?: string; stderr?: string };
  const subprocessMessage =
    subprocessError.shortMessage || subprocessError.stderr;
  if (subprocessMessage) {
    return subprocessMessage.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function execaGatewayError(error: unknown): PipelineMcpGatewayError {
  return error instanceof PipelineMcpGatewayError
    ? error
    : gatewayError(execaErrorMessage(error));
}

function toolHiveWorkloadTransport(
  item: ToolHiveListWorkload
): string | undefined {
  if (typeof item.transport_type === "string") {
    return item.transport_type;
  }
  if (typeof item.transport === "string") {
    return item.transport;
  }
  return;
}

function parseToolHiveWorkloads(stdout: string): ToolHiveWorkload[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw gatewayError(
      "ToolHive list returned malformed JSON while reconciling MCP gateway workloads."
    );
  }
  if (!Array.isArray(parsed)) {
    throw gatewayError(
      "ToolHive list returned a non-array payload while reconciling MCP gateway workloads."
    );
  }
  return parsed.flatMap((item: ToolHiveListWorkload) =>
    toToolHiveWorkload(item)
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toToolHiveWorkload(item: ToolHiveListWorkload): ToolHiveWorkload[] {
  if (!item || typeof item.name !== "string") {
    return [];
  }
  return [
    {
      name: item.name,
      status: asString(item.status),
      transport: toolHiveWorkloadTransport(item),
      url: asString(item.url),
    },
  ];
}

function isHealthyGatewayStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 405;
}

function activeDockerHost(cwd: string): Effect.Effect<string | undefined> {
  return Effect.tryPromise({
    catch: () => undefined,
    try: async () => {
      const result = await execa("docker", ["context", "inspect"], {
        cwd,
        stdin: "ignore",
      });
      const contexts = JSON.parse(result.stdout) as Array<{
        Endpoints?: { docker?: { Host?: unknown } };
      }>;
      const host = contexts[0]?.Endpoints?.docker?.Host;
      return typeof host === "string" && host.length > 0 ? host : undefined;
    },
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

function toolhiveEnv(cwd: string): Effect.Effect<NodeJS.ProcessEnv> {
  if (process.env.DOCKER_HOST) {
    return Effect.succeed(process.env);
  }
  return activeDockerHost(cwd).pipe(
    Effect.map((dockerHost) =>
      dockerHost ? { ...process.env, DOCKER_HOST: dockerHost } : process.env
    )
  );
}

function fetchGateway(
  url: string,
  init: RequestInit
): Effect.Effect<Response, PipelineMcpGatewayError> {
  return Effect.tryPromise({
    catch: execaGatewayError,
    try: () => fetch(url, init),
  });
}

export class McpGatewayService extends Context.Tag("McpGatewayService")<
  McpGatewayService,
  {
    readonly callGatewayRpc: (
      url: string,
      body: Record<string, unknown>,
      authorization?: string
    ) => Effect.Effect<GatewayRpcResponse, PipelineMcpGatewayError>;
    readonly firstHealthyGatewayResponse: (
      urls: string[],
      authorization?: string
    ) => Effect.Effect<Response | undefined, PipelineMcpGatewayError>;
    readonly listToolHiveGroupWorkloads: (
      group: string,
      cwd: string
    ) => Effect.Effect<ToolHiveWorkload[], PipelineMcpGatewayError>;
    readonly localGatewayStatus: (
      cwd: string
    ) => Effect.Effect<string, PipelineMcpGatewayError>;
    readonly runToolHiveVersion: (
      cwd: string
    ) => Effect.Effect<void, PipelineMcpGatewayError>;
    readonly serveToolHiveVmcp: (
      configPath: string,
      cwd: string
    ) => Effect.Effect<void, PipelineMcpGatewayError>;
    readonly validateToolHiveVmcp: (
      configPath: string,
      cwd: string
    ) => Effect.Effect<void, PipelineMcpGatewayError>;
  }
>() {}

export const McpGatewayServiceLive = Layer.succeed(McpGatewayService, {
  callGatewayRpc: (url, body, authorization) =>
    fetchGateway(url, {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      method: "POST",
    }).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(
            gatewayError(`Gateway MCP request failed: HTTP ${response.status}.`)
          );
        }
        return Effect.tryPromise({
          catch: execaGatewayError,
          try: () => response.json() as Promise<GatewayRpcResponse>,
        });
      })
    ),
  firstHealthyGatewayResponse: (urls, authorization) =>
    Effect.gen(function* () {
      for (const url of urls) {
        const response = yield* fetchGateway(url, {
          headers: {
            Accept: "application/json, text/event-stream",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          method: "GET",
        });
        if (isHealthyGatewayStatus(response.status)) {
          return response;
        }
      }
      return;
    }),
  listToolHiveGroupWorkloads: (group, cwd) =>
    Effect.gen(function* () {
      const env = yield* toolhiveEnv(cwd);
      const result = yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: () =>
          execa("thv", ["list", "--group", group, "--format", "json"], {
            cwd,
            env,
            stdin: "ignore",
          }),
      });
      return yield* Effect.try({
        catch: execaGatewayError,
        try: () => parseToolHiveWorkloads(result.stdout),
      });
    }),
  localGatewayStatus: (cwd) =>
    Effect.gen(function* () {
      const env = yield* toolhiveEnv(cwd);
      const result = yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: () => execa("thv", ["list"], { cwd, env }),
      });
      return result.stdout.trim();
    }),
  runToolHiveVersion: (cwd) =>
    Effect.gen(function* () {
      const env = yield* toolhiveEnv(cwd);
      yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: () => execa("thv", ["version"], { cwd, env, stdin: "ignore" }),
      });
    }),
  serveToolHiveVmcp: (configPath, cwd) =>
    Effect.gen(function* () {
      const env = yield* toolhiveEnv(cwd);
      yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: () =>
          execa(
            "thv",
            [
              "vmcp",
              "serve",
              "--config",
              configPath,
              "--host",
              "127.0.0.1",
              "--port",
              "4483",
            ],
            { cwd, env, stderr: "inherit", stdout: "inherit" }
          ),
      });
    }),
  validateToolHiveVmcp: (configPath, cwd) =>
    Effect.gen(function* () {
      const env = yield* toolhiveEnv(cwd);
      yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: () =>
          execa("thv", ["vmcp", "validate", "--config", configPath], {
            cwd,
            env,
            stdin: "ignore",
          }),
      });
    }),
});
